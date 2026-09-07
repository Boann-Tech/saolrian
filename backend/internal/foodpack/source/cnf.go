package source

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCNF is the Canadian Nutrient File's source value in food_ref.
const SourceCNF = "cnf"

const (
	cnfLicence = "ogl-canada"
	cnfRegion  = "ca"
	cnfURL     = "https://food-nutrition.canada.ca/cnf-fce/"
)

// cnfValues: CNF usually leaves an unmeasured nutrient's row out of
// NUTRIENT AMOUNT.csv entirely rather than writing a sentinel, so a blank
// cell is the common case, but "NA" appears too and is handled the same
// way: absent, not zero.
var cnfValues = ValueSyntax{Absent: []string{"NA"}}

// CNFOptions configures the Canadian Nutrient File adapter.
type CNFOptions struct {
	Dir      string // directory of extracted CNF CSVs
	Mapping  *Mapping
	Unmapped UnmappedSink
}

type cnfNutrient struct {
	name string
	unit string
}

type cnfFood struct {
	name   string
	nameFr string
}

// LoadCNF reads the Canadian Nutrient File CSV export.
func LoadCNF(o CNFOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("cnf: mapping is required")
	}

	nutrients, err := cnfNutrients(o.Dir)
	if err != nil {
		return nil, nil, err
	}
	if err := cnfCheckMapping(o.Mapping, nutrients); err != nil {
		return nil, nil, err
	}

	foods, order, err := cnfFoods(o.Dir)
	if err != nil {
		return nil, nil, err
	}

	profiles := map[string]food.Profile{}
	err = eachCSVRow(filepath.Join(o.Dir, "NUTRIENT AMOUNT.csv"),
		[]string{"FoodID", "NutrientID", "NutrientValue"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			if _, ok := foods[id]; !ok {
				return nil
			}
			code := strings.TrimSpace(get("NutrientID"))
			n, known := nutrients[code]
			if !known {
				return nil // a nutrient this release's name table does not define
			}
			value, present, err := cnfValues.Parse(get("NutrientValue"))
			if err != nil {
				return fmt.Errorf("food %s nutrient %s: %w", id, code, err)
			}
			if !present {
				return nil
			}
			key, out, ok := o.Mapping.Apply(code, value)
			if !ok {
				if !o.Mapping.Known(code) {
					noteUnmapped(o.Unmapped, code, n.name)
				}
				return nil
			}
			if profiles[id] == nil {
				profiles[id] = food.Profile{}
			}
			profiles[id][key] = out
			return nil
		})
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}

	portions, err := cnfPortions(o.Dir, foods)
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}

	b := NewBuilder()
	for _, id := range order {
		f := foods[id]
		b.Add(FoodInput{
			Source:      SourceCNF,
			SourceID:    id,
			Region:      cnfRegion,
			Licence:     cnfLicence,
			Name:        f.name,
			SearchExtra: f.nameFr,
			Profile:     profiles[id],
			Portions:    portions[id],
		})
	}
	if err := b.Err("cnf"); err != nil {
		return nil, nil, err
	}
	b.ReportExcluded()

	rows := b.Rows()[SourceCNF]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCNF, Region: cnfRegion, Licence: cnfLicence,
		URL: cnfURL, Rows: rows,
	}}, nil
}

func cnfNutrients(dir string) (map[string]cnfNutrient, error) {
	out := map[string]cnfNutrient{}
	err := eachCSVRow(filepath.Join(dir, "NUTRIENT NAME.csv"),
		[]string{"NutrientID", "NutrientUnit", "NutrientName"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("NutrientID"))
			if id == "" {
				return nil
			}
			out[id] = cnfNutrient{
				name: strings.TrimSpace(get("NutrientName")),
				unit: strings.ToLower(strings.TrimSpace(get("NutrientUnit"))),
			}
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("cnf: %w", err)
	}
	return out, nil
}

// cnfCheckMapping fails the build when the mapping is stale or a factor of
// 1 disagrees with the unit CNF declares.
func cnfCheckMapping(m *Mapping, nutrients map[string]cnfNutrient) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue // explicitly ignored codes need not exist
		}
		n, present := nutrients[code]
		if !present {
			return fmt.Errorf("cnf: %w: NutrientID %s", ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			// The mapping deliberately converts; the factor is the
			// human-audited assertion and the units are expected to differ.
			continue
		}
		if !unitMatches(unit, n.unit) {
			return fmt.Errorf("cnf NutrientID %s (%s): source unit %q but canonical unit is %q; check the factor in mapping/cnf.csv",
				code, n.name, n.unit, unit)
		}
	}
	return nil
}

func cnfFoods(dir string) (map[string]cnfFood, []string, error) {
	foods := map[string]cnfFood{}
	var order []string
	err := eachCSVRow(filepath.Join(dir, "FOOD NAME.csv"),
		[]string{"FoodID", "FoodDescription"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			name := strings.TrimSpace(get("FoodDescription"))
			if id == "" || name == "" {
				return nil
			}
			if _, seen := foods[id]; seen {
				return nil // first row wins, as in usdaFoods
			}
			foods[id] = cnfFood{name: name, nameFr: strings.TrimSpace(get("FoodDescriptionF"))}
			order = append(order, id)
			return nil
		})
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}
	return foods, order, nil
}

// cnfPortions joins CONVERSION FACTOR to MEASURE NAME.
//
// ConversionFactorValue multiplies the per-100g figures, so the measure
// weighs factor*100 grams. Treating it as grams directly turns "1 medium
// banana" into 1.18 g.
func cnfPortions(dir string, foods map[string]cnfFood) (map[string][]format.Portion, error) {
	measures := map[string]string{}
	if err := eachCSVRow(filepath.Join(dir, "MEASURE NAME.csv"),
		[]string{"MeasureID", "MeasureDescription"},
		func(get func(string) string) error {
			measures[strings.TrimSpace(get("MeasureID"))] = strings.TrimSpace(get("MeasureDescription"))
			return nil
		}); err != nil {
		return nil, err
	}

	type measured struct {
		id string
		p  format.Portion
	}
	acc := map[string][]measured{}
	err := eachCSVRow(filepath.Join(dir, "CONVERSION FACTOR.csv"),
		[]string{"FoodID", "MeasureID", "ConversionFactorValue"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			if _, ok := foods[id]; !ok {
				return nil
			}
			measureID := strings.TrimSpace(get("MeasureID"))
			label := measures[measureID]
			if label == "" {
				return nil
			}
			factor, err := strconv.ParseFloat(strings.TrimSpace(get("ConversionFactorValue")), 64)
			if err != nil || factor <= 0 {
				return nil
			}
			acc[id] = append(acc[id], measured{
				id: measureID,
				p:  format.Portion{Label: label, Grams: factor * 100},
			})
			return nil
		})
	if err != nil {
		return nil, err
	}

	// CNF has no sequence column, so order by MeasureID to keep two builds
	// of the same archive byte-identical.
	out := make(map[string][]format.Portion, len(acc))
	for id, ms := range acc {
		sort.SliceStable(ms, func(i, j int) bool {
			a, _ := strconv.Atoi(ms[i].id)
			b, _ := strconv.Atoi(ms[j].id)
			return a < b
		})
		list := make([]format.Portion, 0, len(ms))
		for _, m := range ms {
			list = append(list, m.p)
		}
		out[id] = list
	}
	return out, nil
}
