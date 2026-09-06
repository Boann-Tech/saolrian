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

// ErrMappingNotInSource means the mapping table references a nutrient code
// the dataset does not define — a stale mapping that would silently drop
// data.
var ErrMappingNotInSource = errors.New("mapped nutrient code absent from source dataset")

// ErrDuplicateNutrientNumber means two FDC nutrient ids declare the same
// nutrient_nbr. The whole adapter keys on nutrient_nbr because it is the
// stable identifier across releases; if it is not unique, which of the two
// definitions wins is decided by Go map ordering, so the same archive
// builds a different pack on every run. Fail instead of guessing.
var ErrDuplicateNutrientNumber = errors.New("nutrient_nbr defined by two different nutrient ids")

// The USDA source subtypes, spelled exactly as spec §2 enumerates them for
// food_ref.source. These constants and the region/licence/URL strings below
// are the single definition: the CLI takes its SourceInfo from LoadUSDA
// rather than restating them, because when the two disagreed there was no
// way to join a food to its attribution row.
const (
	SourceUSDAFoundation = "usda_foundation"
	SourceUSDASR         = "usda_sr"
)

const (
	usdaLicence = "public-domain"
	usdaRegion  = "us"
	usdaURL     = "https://fdc.nal.usda.gov/"
)

// usdaSubtypeOrder fixes the order of the returned SourceInfo slice, so two
// builds of the same archive produce byte-identical packs.
var usdaSubtypeOrder = []string{SourceUSDAFoundation, SourceUSDASR}

// usdaEnergyFallbackOrder are FDC's computed-energy nutrient numbers, tried
// in this order for any food whose mapped energy code (nutrient_nbr 208,
// mapped to energy_kcal in mapping/usda.csv) produced no value at all.
//
// USDA Foundation Foods commonly reports energy this way instead of the
// classic "Energy" figure 208 uses: of one 2025 Foundation release's ~340
// foods, only 97 carry 208 while 299 carry 957 (Atwater General Factors)
// and 289 carry 958 (Atwater Specific Factors); SR Legacy never defines
// either number at all, so this fallback is inert there. LoadMapping
// allows only one source_code per canonical key, and 208 stays the mapped
// code because it covers SR Legacy's much larger ~7,800-food set — mapping
// 957 or 958 there instead would trade a small, real gap for a huge one.
// This fallback is where Foundation's real energy figure is picked up
// instead, per food, only when 208 is absent for it.
var usdaEnergyFallbackOrder = []string{"957", "958"}

// applyUSDAEnergyFallback fills energy_kcal from usdaEnergyFallbackOrder
// for any food in profiles that has no energy_kcal of its own, using the
// first fallback number that food actually reported. A food with neither
// 208 nor any fallback figure is left exactly as it was: absence stays
// absence, per Profile's own contract.
func applyUSDAEnergyFallback(profiles map[string]food.Profile, fallback map[string]map[string]float64) {
	for fdcID, byNumber := range fallback {
		if _, has := profiles[fdcID]["energy_kcal"]; has {
			continue
		}
		for _, code := range usdaEnergyFallbackOrder {
			v, ok := byNumber[code]
			if !ok {
				continue
			}
			if profiles[fdcID] == nil {
				profiles[fdcID] = food.Profile{}
			}
			profiles[fdcID]["energy_kcal"] = v
			break
		}
	}
}

// usdaSourceFor maps an FDC data_type to a canonical source value.
func usdaSourceFor(dataType string) string {
	if dataType == "foundation_food" {
		return SourceUSDAFoundation
	}
	return SourceUSDASR
}

// USDAOptions configures the FoodData Central adapter.
type USDAOptions struct {
	Dir       string   // directory of extracted FDC CSVs
	DataTypes []string // e.g. "foundation_food", "sr_legacy_food"
	Mapping   *Mapping
	// Unmapped, when set, is told about every source nutrient code the
	// mapping does not cover. Optional.
	Unmapped UnmappedSink
}

// LoadUSDA reads the FDC CSV export and returns canonical reference foods
// alongside one SourceInfo per USDA subtype that actually contributed rows.
func LoadUSDA(o USDAOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("usda: mapping is required")
	}

	nutrients, err := usdaNutrients(o.Dir)
	if err != nil {
		return nil, nil, err
	}
	if err := usdaCheckMapping(o.Mapping, nutrients); err != nil {
		return nil, nil, err
	}

	foods, order, err := usdaFoods(o.Dir, o.DataTypes)
	if err != nil {
		return nil, nil, err
	}

	profiles := map[string]food.Profile{}
	fallbackEnergy := map[string]map[string]float64{} // fdcID -> nutrient_nbr -> kcal
	if err := eachCSVRow(filepath.Join(o.Dir, "food_nutrient.csv"),
		[]string{"fdc_id", "nutrient_id", "amount"},
		func(get func(string) string) error {
			fdcID := get("fdc_id")
			if _, ok := foods[fdcID]; !ok {
				return nil // a food we filtered out
			}
			n, ok := nutrients[get("nutrient_id")]
			if !ok {
				return nil // nutrient not in this release's table
			}
			amount, err := strconv.ParseFloat(strings.TrimSpace(get("amount")), 64)
			if err != nil {
				return nil // blank amounts are common and simply mean no data
			}
			key, value, ok := o.Mapping.Apply(n.number, amount)
			if !ok {
				if !o.Mapping.Known(n.number) {
					noteUnmapped(o.Unmapped, n.number, n.name)
				}
				// mapping/usda.csv ignores 957/958 outright (see
				// usdaEnergyFallbackOrder's doc comment for why), but the
				// raw kcal figure is still worth remembering per food in
				// case 208 turns out absent for it.
				for _, fb := range usdaEnergyFallbackOrder {
					if n.number == fb {
						if fallbackEnergy[fdcID] == nil {
							fallbackEnergy[fdcID] = map[string]float64{}
						}
						fallbackEnergy[fdcID][fb] = amount
					}
				}
				return nil // unmapped or explicitly ignored
			}
			if profiles[fdcID] == nil {
				profiles[fdcID] = food.Profile{}
			}
			profiles[fdcID][key] = value
			return nil
		}); err != nil {
		return nil, nil, err
	}
	applyUSDAEnergyFallback(profiles, fallbackEnergy)

	portions, err := usdaPortions(o.Dir, foods)
	if err != nil {
		return nil, nil, err
	}

	b := NewBuilder()
	for _, fdcID := range order {
		f := foods[fdcID]
		b.Add(FoodInput{
			Source:   f.source,
			SourceID: fdcID,
			Region:   usdaRegion,
			Licence:  usdaLicence,
			Name:     f.name,
			Profile:  profiles[fdcID],
			Portions: portions[fdcID],
		})
	}
	if err := b.Err("usda"); err != nil {
		return nil, nil, err
	}
	b.ReportExcluded()

	rows := b.Rows()
	var sources []format.SourceInfo
	for _, sub := range usdaSubtypeOrder {
		if rows[sub] == 0 {
			continue
		}
		sources = append(sources, format.SourceInfo{
			Source: sub, Region: usdaRegion, Licence: usdaLicence,
			URL: usdaURL, Rows: rows[sub],
		})
	}
	return b.Foods(), sources, nil
}

type usdaNutrient struct {
	number string
	unit   string
	name   string
}

type usdaFood struct {
	name   string
	source string
}

// usdaNutrients maps FDC internal nutrient id -> stable nutrient_nbr + unit.
//
// It rejects a dataset in which two ids declare the same non-empty
// nutrient_nbr. Everything downstream — the mapping check and the data path
// alike — collapses ids to nutrient_nbr, so a collision means one
// definition silently overwrites the other in an order Go map iteration
// picks at random.
func usdaNutrients(dir string) (map[string]usdaNutrient, error) {
	out := map[string]usdaNutrient{}
	definedBy := map[string]string{} // nutrient_nbr -> the id that first declared it

	err := eachCSVRow(filepath.Join(dir, "nutrient.csv"),
		[]string{"id", "unit_name", "nutrient_nbr", "name"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("id"))
			n := usdaNutrient{
				number: strings.TrimSpace(get("nutrient_nbr")),
				unit:   strings.ToUpper(strings.TrimSpace(get("unit_name"))),
				name:   strings.TrimSpace(get("name")),
			}
			if n.number != "" {
				if prev, seen := definedBy[n.number]; seen && prev != id {
					return fmt.Errorf("%w: nutrient_nbr %s is declared by nutrient id %s and again by id %s in nutrient.csv",
						ErrDuplicateNutrientNumber, n.number, prev, id)
				}
				definedBy[n.number] = id
			}
			out[id] = n
			return nil
		})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// usdaCheckMapping fails the build when the mapping is stale or its factor
// disagrees with the dataset's declared unit.
//
// usdaNutrients has already guaranteed nutrient_nbr is unique, so this
// by-number index cannot lose a definition.
func usdaCheckMapping(m *Mapping, nutrients map[string]usdaNutrient) error {
	byNumber := map[string]usdaNutrient{}
	for _, n := range nutrients {
		byNumber[n.number] = n
	}
	for _, code := range m.Codes() {
		n, present := byNumber[code]
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue // explicitly ignored codes need not exist
		}
		if !present {
			return fmt.Errorf("%w: nutrient_nbr %s", ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			// The mapping deliberately converts units; the factor itself
			// is the human-audited assertion, so the source's unit_name
			// need not match the canonical unit.
			continue
		}
		if want := usdaUnitFor(unit); want != "" && n.unit != want {
			return fmt.Errorf("usda nutrient_nbr %s: source unit %q but canonical unit is %q; check the factor in mapping/usda.csv",
				code, n.unit, unit)
		}
	}
	return nil
}

// usdaUnitFor is the FDC spelling of a canonical unit.
func usdaUnitFor(u food.Unit) string {
	switch u {
	case food.UnitKcal:
		return "KCAL"
	case food.UnitG:
		return "G"
	case food.UnitMg:
		return "MG"
	case food.UnitUg:
		return "UG"
	}
	return ""
}

func usdaFoods(dir string, dataTypes []string) (map[string]usdaFood, []string, error) {
	want := map[string]bool{}
	for _, dt := range dataTypes {
		want[dt] = true
	}
	foods := map[string]usdaFood{}
	var order []string

	err := eachCSVRow(filepath.Join(dir, "food.csv"),
		[]string{"fdc_id", "data_type", "description"},
		func(get func(string) string) error {
			dt := strings.TrimSpace(get("data_type"))
			if !want[dt] {
				return nil
			}
			name := strings.TrimSpace(get("description"))
			if name == "" {
				return nil
			}
			id := get("fdc_id")
			if _, seen := foods[id]; seen {
				// A repeated fdc_id would append to order twice and emit two
				// RefFoods with the same (source, source_id), which is the
				// unique index the seed migration relies on. First row wins.
				return nil
			}
			foods[id] = usdaFood{name: name, source: usdaSourceFor(dt)}
			order = append(order, id)
			return nil
		})
	return foods, order, err
}

func usdaPortions(dir string, foods map[string]usdaFood) (map[string][]format.Portion, error) {
	units := map[string]string{}
	if err := eachCSVRow(filepath.Join(dir, "measure_unit.csv"),
		[]string{"id", "name"},
		func(get func(string) string) error {
			units[get("id")] = strings.TrimSpace(get("name"))
			return nil
		}); err != nil {
		return nil, err
	}

	type seqPortion struct {
		seq int
		p   format.Portion
	}
	acc := map[string][]seqPortion{}

	err := eachCSVRow(filepath.Join(dir, "food_portion.csv"),
		[]string{"fdc_id", "seq_num", "amount", "measure_unit_id", "modifier", "gram_weight"},
		func(get func(string) string) error {
			id := get("fdc_id")
			if _, ok := foods[id]; !ok {
				return nil
			}
			grams, err := strconv.ParseFloat(strings.TrimSpace(get("gram_weight")), 64)
			if err != nil || grams <= 0 {
				return nil
			}
			label := usdaPortionLabel(get("amount"), units[get("measure_unit_id")], get("modifier"))
			if label == "" {
				return nil
			}
			seq, _ := strconv.Atoi(strings.TrimSpace(get("seq_num")))
			acc[id] = append(acc[id], seqPortion{seq: seq, p: format.Portion{Label: label, Grams: grams}})
			return nil
		})
	if err != nil {
		return nil, err
	}

	out := make(map[string][]format.Portion, len(acc))
	for id, ps := range acc {
		sort.SliceStable(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
		list := make([]format.Portion, 0, len(ps))
		for _, sp := range ps {
			list = append(list, sp.p)
		}
		out[id] = list
	}
	return out, nil
}

// usdaPortionLabel builds "1 medium" / "1 cup, sliced" from FDC's split
// amount / measure unit / modifier columns. "undetermined" is FDC's
// placeholder unit and contributes nothing.
func usdaPortionLabel(amount, unit, modifier string) string {
	amount = strings.TrimSpace(amount)
	unit = strings.TrimSpace(unit)
	modifier = strings.TrimSpace(modifier)
	if unit == "undetermined" {
		unit = ""
	}
	head := strings.TrimSpace(amount + " " + unit)
	switch {
	case head != "" && modifier != "":
		return head + " " + modifier
	case head != "":
		return head
	case modifier != "":
		return modifier
	}
	return ""
}
