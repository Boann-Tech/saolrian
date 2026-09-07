package source

import (
	"errors"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCoFID is McCance & Widdowson's Composition of Foods Integrated
// Dataset, as it appears in food_ref.source.
const SourceCoFID = "cofid"

const (
	cofidLicence = "ogl-uk"
	cofidRegion  = "uk"
	cofidURL     = "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid"
)

// cofidValues is CoFID's cell grammar. Tr is a measured trace, N was never
// measured, and a bracketed figure is estimated or taken from a similar
// food.
var cofidValues = ValueSyntax{
	Absent: []string{"N", "-", "n/a"},
	Trace:  []string{"Tr"},
}

// Defaults for the 2021 release, read off the real workbook. Every one of
// these has moved at least once between releases, which is why they are
// options rather than literals in the reading code.
var cofidDefaultSheets = []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"}

const (
	// cofidDefaultHeaderRow is 1: the 2021 workbook opens straight onto the
	// column titles. Rows 2 and 3 are a second and third heading band --
	// the short field code (SATFOD) and a long gloss ("Saturated fatty
	// acids per 100g food") -- and data starts at row 4. Those two bands
	// carry no food code, so the blank-code skip below drops them before
	// their text ever reaches Parse.
	cofidDefaultHeaderRow  = 1
	cofidDefaultCodeColumn = "food code"
	cofidDefaultNameColumn = "food name"
)

// CoFIDOptions configures the CoFID adapter.
type CoFIDOptions struct {
	Dir  string // directory holding the workbook
	File string // explicit workbook path, overriding Dir
	// Sheets are read in order and joined on the food code. Defaults to
	// the proximates, inorganics and vitamins sheets.
	Sheets []string
	// HeaderRow is 1-based, as read off the spreadsheet. Defaults to 3:
	// the release title and the "per 100 g" note sit above it.
	HeaderRow  int
	CodeColumn string
	NameColumn string
	Mapping    *Mapping
	Unmapped   UnmappedSink
}

func (o *CoFIDOptions) applyDefaults() {
	if len(o.Sheets) == 0 {
		o.Sheets = cofidDefaultSheets
	}
	if o.HeaderRow == 0 {
		o.HeaderRow = cofidDefaultHeaderRow
	}
	if o.CodeColumn == "" {
		o.CodeColumn = cofidDefaultCodeColumn
	}
	if o.NameColumn == "" {
		o.NameColumn = cofidDefaultNameColumn
	}
	o.CodeColumn = normaliseHeader(o.CodeColumn)
	o.NameColumn = normaliseHeader(o.NameColumn)
}

// LoadCoFID reads the CoFID workbook, assembling each food's profile from
// however many sheets carry a row for its food code.
func LoadCoFID(o CoFIDOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("cofid: mapping is required")
	}
	o.applyDefaults()

	path, err := findWorkbook(o.Dir, o.File)
	if err != nil {
		return nil, nil, fmt.Errorf("cofid: %w", err)
	}
	wb, err := excelize.OpenFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("cofid: open %s: %w", path, err)
	}
	defer wb.Close()

	tables := make([]*sheetTable, 0, len(o.Sheets))
	headers := map[string]bool{}
	for _, name := range o.Sheets {
		t, err := readSheet(wb, name, o.HeaderRow)
		if err != nil {
			return nil, nil, fmt.Errorf("cofid: %w", err)
		}
		if !t.Has(o.CodeColumn) && !t.NameFirstColumn(o.CodeColumn) {
			return nil, nil, fmt.Errorf("cofid: sheet %q has no %q column (headers: %v)", name, o.CodeColumn, t.Header)
		}
		for _, h := range t.Header {
			if h != "" {
				headers[h] = true
			}
		}
		tables = append(tables, t)
	}
	if err := headerMappingCheck("cofid", o.Mapping, headers, "mapping/cofid.csv"); err != nil {
		return nil, nil, err
	}

	names := map[string]string{}
	profiles := map[string]food.Profile{}
	var order []string

	for _, t := range tables {
		for _, row := range t.Rows {
			code, _ := t.Cell(row, o.CodeColumn)
			code = strings.TrimSpace(code)
			if code == "" {
				continue
			}
			// A blank name cell on this row must not skip the nutrient
			// loop below: a food code is confirmed by any sheet, and the
			// name may legitimately arrive from a different one. Dropping
			// this row's nutrients because *this* sheet happens not to
			// carry the name would be silent data loss -- exactly what
			// "absent is not zero" rules out. A code that never acquires
			// a name on any sheet is still dropped, just later: it is
			// never added to order, so Builder.Add never sees it.
			if _, seen := names[code]; !seen {
				if name, _ := t.Cell(row, o.NameColumn); strings.TrimSpace(name) != "" {
					names[code] = strings.TrimSpace(name)
					order = append(order, code)
				}
			}
			for _, h := range t.Header {
				if h == "" || h == o.CodeColumn || h == o.NameColumn {
					continue
				}
				// Consult the mapping before Parse, not after. Real
				// workbooks carry free-text columns (Description, Group,
				// Previous, Main data references, Footnote); Parse on
				// "Cereals and cereal products" raises ErrUnknownToken,
				// which is fatal by design. An unmapped column is noted
				// and skipped without ever being parsed; an explicitly
				// ignored ("-") column is skipped the same way, silently,
				// because ignoring it is the whole point.
				if !o.Mapping.Known(h) {
					noteUnmapped(o.Unmapped, h, t.Sheet)
					continue
				}
				if o.Mapping.Ignored(h) {
					continue
				}
				raw, ok := t.Cell(row, h)
				if !ok {
					continue
				}
				value, present, err := cofidValues.Parse(raw)
				if err != nil {
					return nil, nil, fmt.Errorf("cofid: sheet %q food %s column %q: %w", t.Sheet, code, h, err)
				}
				if !present {
					continue
				}
				key, out, mapped := o.Mapping.Apply(h, value)
				if !mapped {
					// Known and not ignored means mapped; Apply cannot
					// fail here. Kept as a guard rather than a panic.
					continue
				}
				if profiles[code] == nil {
					profiles[code] = food.Profile{}
				}
				profiles[code][key] = out
			}
		}
	}

	b := NewBuilder()
	for _, code := range order {
		b.Add(FoodInput{
			Source:   SourceCoFID,
			SourceID: code,
			Region:   cofidRegion,
			Licence:  cofidLicence,
			Name:     names[code],
			Profile:  profiles[code],
			// CoFID publishes no household measures in these sheets.
		})
	}
	if err := b.Err("cofid"); err != nil {
		return nil, nil, err
	}
	b.ReportExcluded()

	rows := b.Rows()[SourceCoFID]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCoFID, Region: cofidRegion, Licence: cofidLicence,
		URL: cofidURL, Rows: rows,
	}}, nil
}
