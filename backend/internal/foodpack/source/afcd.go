package source

import (
	"errors"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceAFCD is the Australian Food Composition Database's source value in
// food_ref.
const SourceAFCD = "afcd"

const (
	afcdLicence = "cc-by-3.0-au"
	afcdRegion  = "au"
	afcdURL     = "https://www.foodstandards.gov.au/science-data/food-composition-databases"
)

// afcdValues: a blank cell means "not measured". Release 3 writes nothing
// else -- every cell in the per-100g sheet is either a number or empty, with
// no sentinel text anywhere -- so in practice only the blank case fires.
// "N", "-" and "Tr" are kept because earlier releases and the sibling
// workbooks do spell missing data out, and because a sentinel this file does
// not declare is fatal rather than silently zero; carrying them costs
// nothing and turns a future release's "N" into data instead of an abort.
var afcdValues = ValueSyntax{
	Absent: []string{"N", "-"},
	Trace:  []string{"Tr"},
}

const (
	// Defaults for Release 3's "Nutrient profiles" workbook. The sheet name
	// gained a space before the "g" in Release 3, and the header sits on row
	// 3 under two merged title rows.
	afcdDefaultSheet      = "All solids & liquids per 100 g"
	afcdDefaultHeaderRow  = 3
	afcdDefaultCodeColumn = "public food key"
	afcdDefaultNameColumn = "food name"
)

// AFCDOptions configures the Australian Food Composition Database adapter.
type AFCDOptions struct {
	Dir        string
	File       string
	Sheet      string
	HeaderRow  int
	CodeColumn string
	NameColumn string
	Mapping    *Mapping
	Unmapped   UnmappedSink
}

func (o *AFCDOptions) applyDefaults() {
	if o.Sheet == "" {
		o.Sheet = afcdDefaultSheet
	}
	if o.HeaderRow == 0 {
		o.HeaderRow = afcdDefaultHeaderRow
	}
	if o.CodeColumn == "" {
		o.CodeColumn = afcdDefaultCodeColumn
	}
	if o.NameColumn == "" {
		o.NameColumn = afcdDefaultNameColumn
	}
	o.CodeColumn = normaliseHeader(o.CodeColumn)
	o.NameColumn = normaliseHeader(o.NameColumn)
}

// LoadAFCD reads the AFCD per-100g sheet.
func LoadAFCD(o AFCDOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("afcd: mapping is required")
	}
	o.applyDefaults()

	path, err := findWorkbook(o.Dir, o.File)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: %w", err)
	}
	wb, err := excelize.OpenFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: open %s: %w", path, err)
	}
	defer wb.Close()

	t, err := readSheet(wb, o.Sheet, o.HeaderRow)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: %w", err)
	}
	for _, want := range []string{o.CodeColumn, o.NameColumn} {
		if !t.Has(want) {
			return nil, nil, fmt.Errorf("afcd: sheet %q has no %q column (headers: %v)", o.Sheet, want, t.Header)
		}
	}
	headers := map[string]bool{}
	for _, h := range t.Header {
		if h != "" {
			headers[h] = true
		}
	}
	if err := headerMappingCheck("afcd", o.Mapping, headers, "mapping/afcd.csv"); err != nil {
		return nil, nil, err
	}

	b := NewBuilder()
	for _, row := range t.Rows {
		code, _ := t.Cell(row, o.CodeColumn)
		code = strings.TrimSpace(code)
		name, _ := t.Cell(row, o.NameColumn)
		name = strings.TrimSpace(name)
		if code == "" || name == "" {
			continue
		}

		prof := food.Profile{}
		for _, h := range t.Header {
			if h == "" || h == o.CodeColumn || h == o.NameColumn {
				continue
			}
			// Consult the mapping before Parse, not after. Real
			// workbooks carry free-text columns (Description, Group,
			// Previous, Main data references, Footnote); Parse on one of
			// those raises ErrUnknownToken, which is fatal by design. An
			// unmapped column is noted and skipped without ever being
			// parsed; an explicitly ignored ("-") column is skipped the
			// same way, silently, because ignoring it is the whole point.
			if !o.Mapping.Known(h) {
				noteUnmapped(o.Unmapped, h, o.Sheet)
				continue
			}
			if o.Mapping.Ignored(h) {
				continue
			}
			raw, ok := t.Cell(row, h)
			if !ok {
				continue
			}
			value, present, err := afcdValues.Parse(raw)
			if err != nil {
				return nil, nil, fmt.Errorf("afcd: food %s column %q: %w", code, h, err)
			}
			if !present {
				continue
			}
			key, out, mapped := o.Mapping.Apply(h, value)
			if !mapped {
				// Known and not ignored means mapped; Apply cannot fail
				// here. Kept as a guard rather than a panic.
				continue
			}
			prof[key] = out
		}

		b.Add(FoodInput{
			Source:   SourceAFCD,
			SourceID: code,
			Region:   afcdRegion,
			Licence:  afcdLicence,
			Name:     name,
			Profile:  prof,
			// AFCD publishes measures in a separate workbook, not this one.
		})
	}
	if err := b.Err("afcd"); err != nil {
		return nil, nil, err
	}
	b.ReportExcluded()

	rows := b.Rows()[SourceAFCD]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceAFCD, Region: afcdRegion, Licence: afcdLicence,
		URL: afcdURL, Rows: rows,
	}}, nil
}
