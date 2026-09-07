// Package food defines the canonical nutrient vocabulary shared by the
// ingest pipeline, the provider layer and the API.
//
// The order of Nutrients is part of the on-disk pack format: packs store
// values positionally. Appending is safe; reordering or removing is not,
// and requires a pack rebuild.
package food

// Unit is a canonical measurement unit. Every nutrient has exactly one.
type Unit string

const (
	UnitKcal Unit = "kcal"
	UnitG    Unit = "g"
	UnitMg   Unit = "mg"
	UnitUg   Unit = "ug"
)

// Group is the display grouping used by the nutrient panel.
type Group string

const (
	GroupEnergy  Group = "energy"
	GroupMacro   Group = "macro"
	GroupMineral Group = "mineral"
	GroupVitamin Group = "vitamin"
)

// Nutrient describes one canonical nutrient.
//
// Max is a deliberately generous per-100g plausible maximum: it exists to
// catch unit errors (a 1000x factor mistake), not to police unusual foods.
// The minimum is always 0.
type Nutrient struct {
	Key   string
	Label string
	Unit  Unit
	Group Group
	Max   float64
}

// Nutrients is the canonical vocabulary in encoding order.
var Nutrients = []Nutrient{
	{"energy_kcal", "Energy", UnitKcal, GroupEnergy, 950},

	{"protein", "Protein", UnitG, GroupMacro, 100},
	{"fat", "Fat", UnitG, GroupMacro, 100},
	{"carbohydrate", "Carbohydrate", UnitG, GroupMacro, 100},
	{"fibre", "Fibre", UnitG, GroupMacro, 100},
	{"sugars", "Sugars", UnitG, GroupMacro, 100},
	{"starch", "Starch", UnitG, GroupMacro, 100},
	{"fat_saturated", "Saturated fat", UnitG, GroupMacro, 100},
	{"fat_monounsaturated", "Monounsaturated fat", UnitG, GroupMacro, 100},
	{"fat_polyunsaturated", "Polyunsaturated fat", UnitG, GroupMacro, 100},
	{"fat_trans", "Trans fat", UnitG, GroupMacro, 100},
	// 3200: USDA SR Legacy publishes 3010mg (raw) / 3100mg (cooked) for beef
	// and veal brain, organ meats genuinely this high in cholesterol.
	// Confirmed against the FDC API itself (fdc_id 168622, 168624, 174352),
	// not a mapping or unit-factor defect.
	{"cholesterol", "Cholesterol", UnitMg, GroupMacro, 3200},
	{"alcohol", "Alcohol", UnitG, GroupMacro, 100},
	{"water", "Water", UnitG, GroupMacro, 100},
	{"ash", "Ash", UnitG, GroupMacro, 100},
	{"salt", "Salt", UnitG, GroupMacro, 100},

	{"sodium", "Sodium", UnitMg, GroupMineral, 40000},
	{"potassium", "Potassium", UnitMg, GroupMineral, 20000},
	{"calcium", "Calcium", UnitMg, GroupMineral, 20000},
	{"magnesium", "Magnesium", UnitMg, GroupMineral, 5000},
	// 10000: USDA SR Legacy's "Leavening agents, baking powder, double-acting,
	// straight phosphate" (fdc_id 172804) publishes 9918mg/100g. Baking
	// powder made from phosphate salts (as opposed to the sodium-aluminum-
	// sulfate kind) is chemically expected to run very high in phosphorus;
	// third-party USDA mirrors report the same figure. Not a unit error.
	{"phosphorus", "Phosphorus", UnitMg, GroupMineral, 10000},
	{"iron", "Iron", UnitMg, GroupMineral, 500},
	{"zinc", "Zinc", UnitMg, GroupMineral, 500},
	// USDA SR Legacy's "Toddler drink, MEAD JOHNSON, PurAmino Toddler
	// Powder... not reconstituted" (fdc_id 172294) publishes 370mg/100g
	// copper -- roughly 1000x a plausible figure for infant formula powder
	// (~0.4mg/100g). This is the source's own data being wrong, not a
	// mapping defect, so the maximum stays put; the food is excluded by
	// name in exclusions.csv instead (see Builder).
	{"copper", "Copper", UnitMg, GroupMineral, 100},
	// 150: USDA SR Legacy's instant tea powders (fdc_id 173230, 174872)
	// publish 125-133mg/100g; tea is well-documented as exceptionally
	// manganese-rich, so 100 was a little tight. The UNILEVER SLIMFAST
	// high-protein shake mix (fdc_id 173174) separately publishes
	// 269.1mg/100g -- implausible against a ~2.3mg daily reference intake,
	// so that food is excluded by name in exclusions.csv rather than
	// raised for here.
	{"manganese", "Manganese", UnitMg, GroupMineral, 150},
	{"selenium", "Selenium", UnitUg, GroupMineral, 6000},
	{"iodine", "Iodine", UnitUg, GroupMineral, 10000},

	{"vitamin_a_rae", "Vitamin A (RAE)", UnitUg, GroupVitamin, 40000},
	{"retinol", "Retinol", UnitUg, GroupVitamin, 40000},
	{"carotene_beta", "Beta-carotene", UnitUg, GroupVitamin, 100000},
	{"vitamin_d", "Vitamin D", UnitUg, GroupVitamin, 500},
	{"vitamin_e", "Vitamin E", UnitMg, GroupVitamin, 500},
	{"vitamin_k", "Vitamin K", UnitUg, GroupVitamin, 5000},
	{"vitamin_c", "Vitamin C", UnitMg, GroupVitamin, 3000},
	{"thiamin", "Thiamin (B1)", UnitMg, GroupVitamin, 100},
	{"riboflavin", "Riboflavin (B2)", UnitMg, GroupVitamin, 100},
	{"niacin", "Niacin (B3)", UnitMg, GroupVitamin, 500},
	{"vitamin_b6", "Vitamin B6", UnitMg, GroupVitamin, 100},
	{"folate", "Folate", UnitUg, GroupVitamin, 5000},
	{"vitamin_b12", "Vitamin B12", UnitUg, GroupVitamin, 500},
	{"pantothenate", "Pantothenic acid (B5)", UnitMg, GroupVitamin, 100},
	{"biotin", "Biotin (B7)", UnitUg, GroupVitamin, 1000},
}

var byKey = func() map[string]int {
	m := make(map[string]int, len(Nutrients))
	for i, n := range Nutrients {
		m[n.Key] = i
	}
	return m
}()

// Index returns the encoding slot for key.
func Index(key string) (int, bool) {
	i, ok := byKey[key]
	return i, ok
}

// Lookup returns the nutrient definition for key.
func Lookup(key string) (Nutrient, bool) {
	i, ok := byKey[key]
	if !ok {
		return Nutrient{}, false
	}
	return Nutrients[i], true
}

// Keys returns the canonical keys in encoding order.
func Keys() []string {
	out := make([]string, len(Nutrients))
	for i, n := range Nutrients {
		out[i] = n.Key
	}
	return out
}
