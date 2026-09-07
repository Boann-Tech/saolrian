package source

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/xuri/excelize/v2"
)

// normaliseHeader turns a spreadsheet header into the form a mapping table
// keys on. CoFID and AFCD have no nutrient code column: a nutrient *is* its
// column heading. Those headings carry line breaks, non-breaking spaces,
// double spaces and inconsistent capitalisation between releases, none of
// which is a real difference, so all of it is folded away before matching.
//
// It also folds the two spellings of mu together: real spreadsheets use
// both U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU for
// micrograms interchangeably, and the difference is invisible in a diff.
// Without this, a mapping table and a workbook that disagree about which
// mu they use would silently fail to match and the nutrient would vanish
// with no visible sign why.
func normaliseHeader(s string) string {
	n := strings.ToLower(strings.Join(strings.Fields(s), " "))
	return strings.ReplaceAll(n, "μ", "µ") // GREEK SMALL LETTER MU -> MICRO SIGN
}

// sheetTable is one worksheet reduced to a normalised header row plus the
// data rows beneath it.
type sheetTable struct {
	Sheet  string
	Header []string
	Rows   [][]string
	index  map[string]int
}

// readSheet reads one worksheet. headerRow is 1-based, matching what a
// person reads off the spreadsheet.
func readSheet(f *excelize.File, sheet string, headerRow int) (*sheetTable, error) {
	if idx, err := f.GetSheetIndex(sheet); err != nil || idx < 0 {
		return nil, fmt.Errorf("workbook has no sheet %q (has %v)", sheet, f.GetSheetList())
	}
	// RawCellValue: the stored number, not the string Excel would paint in
	// the cell. AFCD Release 3 formats its kilojoule column with a
	// thousands separator, so the default rendering hands back "1,236" for
	// a cell holding 1236 -- which is not a number to any parser and, in a
	// dataset that used the comma as a decimal point, would not even be
	// wrong in the same direction. A number format is a display choice
	// that varies by release and by the locale of whoever last saved the
	// file; the value underneath it is the data.
	rows, err := f.GetRows(sheet, excelize.Options{RawCellValue: true})
	if err != nil {
		return nil, fmt.Errorf("read sheet %q: %w", sheet, err)
	}
	if headerRow < 1 || headerRow > len(rows) {
		return nil, fmt.Errorf("sheet %q has %d rows; header row %d is out of range", sheet, len(rows), headerRow)
	}

	t := &sheetTable{Sheet: sheet, index: map[string]int{}}
	for i, h := range rows[headerRow-1] {
		n := normaliseHeader(h)
		t.Header = append(t.Header, n)
		if n == "" {
			continue // trailing blank columns are ordinary in these files
		}
		if prev, dup := t.index[n]; dup {
			return nil, fmt.Errorf("sheet %q: columns %d and %d both normalise to %q; the mapping table cannot tell them apart",
				sheet, prev+1, i+1, n)
		}
		t.index[n] = i
	}
	for _, r := range rows[headerRow:] {
		if isBlankRow(r) {
			continue
		}
		t.Rows = append(t.Rows, r)
	}
	return t, nil
}

func isBlankRow(r []string) bool {
	for _, c := range r {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// Has reports whether the sheet carries a column with this normalised
// header.
func (t *sheetTable) Has(header string) bool {
	_, ok := t.index[header]
	return ok
}

// NameFirstColumn labels column A with header when the workbook left that
// heading blank, and reports whether it could.
//
// CoFID 2021 needs this and nothing else does. Its "1.4 Inorganics" sheet
// has two spaces in A1 where "1.3 Proximates" and "1.5 Vitamins" both say
// "Food Code" -- a typo in the published file, sitting above a column of
// perfectly good food codes. Without a way to name it, a third of CoFID's
// nutrients (every mineral) drop out of the pack over a whitespace cell.
//
// It is deliberately narrow: it will not rename a column that has a
// heading, will not touch anything but column A, and will not create a
// second column under a name the sheet already uses. A sheet that is
// genuinely missing its key still fails, because its column A is missing
// rather than blank.
func (t *sheetTable) NameFirstColumn(header string) bool {
	if len(t.Header) == 0 || t.Header[0] != "" || header == "" {
		return false
	}
	if _, taken := t.index[header]; taken {
		return false
	}
	t.Header[0] = header
	t.index[header] = 0
	return true
}

// Cell returns one cell of a row. ok distinguishes "this sheet has no such
// column" from "the cell is empty", which for a nutrient is the difference
// between a broken mapping and no data.
func (t *sheetTable) Cell(row []string, header string) (string, bool) {
	i, ok := t.index[header]
	if !ok {
		return "", false
	}
	if i >= len(row) {
		return "", true // short row: the column exists, this cell is empty
	}
	return row[i], true
}

// findWorkbook locates the single .xlsx in dir, or honours an explicit
// path. Two workbooks is an error rather than a guess: the download
// directory has held both a current and a superseded release before.
func findWorkbook(dir, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	matches, err := filepath.Glob(filepath.Join(dir, "*.xlsx"))
	if err != nil {
		return "", err
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no .xlsx file in %s", dir)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("%s holds %d workbooks (%v); pass an explicit file", dir, len(matches), matches)
	}
}

// headerMappingCheck is the spreadsheet equivalent of usdaCheckMapping: a
// mapped column header absent from the workbook is a stale mapping, and a
// factor of 1 has to agree with the unit the header states.
//
// Shared by CoFID and AFCD, which identify nutrients the same way: a
// nutrient is a column heading, not a code, so this lives here alongside
// the rest of the shared spreadsheet machinery rather than in one
// adapter's file.
func headerMappingCheck(adapter string, m *Mapping, headers map[string]bool, tablePath string) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue
		}
		if !headers[code] {
			return fmt.Errorf("%s: %w: column %q", adapter, ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			continue // a deliberate conversion; the factor is the assertion
		}
		srcUnit := unitFromLabel(code)
		if srcUnit == "" {
			continue // this header states no unit; nothing to check
		}
		if !unitMatches(unit, srcUnit) {
			return fmt.Errorf("%s column %q: header states unit %q but canonical unit is %q; check the factor in %s",
				adapter, code, srcUnit, unit, tablePath)
		}
	}
	return nil
}
