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

// afcdValues: a blank cell and "N" both mean "not measured", and "-" is
// accepted as an alternative spelling of the same thing. "Tr" is a measured
// trace and parses to a real 0.0. These are handled defensively, in the
// same shape as CoFID's sentinels; they have not yet been confirmed against
// the real AFCD codebook, so treat "N" and "-" as provisional until a real
// download is checked against them.
var afcdValues = ValueSyntax{
	Absent: []string{"N", "-"},
	Trace:  []string{"Tr"},
}

const (
	afcdDefaultSheet      = "All solids & liquids per 100g"
	afcdDefaultHeaderRow  = 1
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
				if !o.Mapping.Known(h) {
					noteUnmapped(o.Unmapped, h, o.Sheet)
				}
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
