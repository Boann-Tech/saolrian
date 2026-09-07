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
	// 110, where every other macro stops at 100: CoFID states carbohydrate
	// as monosaccharide equivalents, which adds back the water a
	// disaccharide takes up on hydrolysis and so runs about 5% above the
	// food's actual mass of carbohydrate. Pure sucrose lands at 105g/100g
	// (white sugar, food code 17-063) and Demerara and icing sugar are
	// just behind it. The figures are right for the convention they are
	// stated in; the convention is simply not mass-conserving. USDA and
	// CIQUAL both report available carbohydrate instead and stay under
	// 100, so this ceiling is really CoFID's alone.
	{"carbohydrate", "Carbohydrate", UnitG, GroupMacro, 110},
	{"fibre", "Fibre", UnitG, GroupMacro, 100},
	// 110 for the same reason as carbohydrate above: CoFID's total sugars
	// are monosaccharide equivalents too, so white sugar is 105g/100g here
	// as well. Starch keeps its 100 -- CoFID states it in the same
	// convention, but no food in the 2021 release actually crosses the
	// line, and a ceiling is only worth moving on evidence.
	{"sugars", "Sugars", UnitG, GroupMacro, 110},
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
	// 55000, by the same reasoning that already puts sodium at 40000:
	// where a food is essentially one salt, its ceiling is that salt's
	// stoichiometry. AFCD publishes 50009mg/100g for potassium chloride
	// salt substitute (F007870) and potassium is 39.1 of KCl's 74.6 g/mol,
	// so pure KCl is 52.4% potassium -- the figure is the compound at
	// about 95% purity. CoFID's cream of tartar (17-358) lands at
	// 20780mg/100g on the same arithmetic: potassium bitartrate, KC4H5O6,
	// is 20.8% potassium.
	{"potassium", "Potassium", UnitMg, GroupMineral, 55000},
	// 40000: CIQUAL publishes 30400mg/100g for dried lithothamnion
	// (alim_code 20989), a calcareous red alga that is roughly a third
	// calcium carbonate by weight and is sold as a calcium supplement on
	// exactly that basis. CIQUAL grades the figure confiance A -- its own
	// highest, analytically determined. Real food, real number.
	{"calcium", "Calcium", UnitMg, GroupMineral, 40000},
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
	// 600000: dried brown seaweeds are in a class of their own for iodine.
	// CIQUAL publishes 459000ug/100g for dried tangle (Laminaria digitata,
	// alim_code 20991) and 233000 for kombu, both confiance A; the food
	// science literature puts dried kelp at 2000-8000 mg/kg, which is the
	// same range. Nine CIQUAL seaweeds sit above the old 10000 ceiling, so
	// this is a whole food category rather than a stray row -- excluding
	// them would lose the foods most worth warning someone about. The
	// ceiling stays finite: iodine reported in mg and read as ug would
	// still have to clear 0.6% of the food's mass to slip through.
	{"iodine", "Iodine", UnitUg, GroupMineral, 600000},

	{"vitamin_a_rae", "Vitamin A (RAE)", UnitUg, GroupVitamin, 40000},
	{"retinol", "Retinol", UnitUg, GroupVitamin, 40000},
	// 200000: CIQUAL publishes 155000ug/100g of beta-carotene for dried
	// spirulina (alim_code 11086), confiance A. Dried microalgae are
	// roughly 0.1-0.2% carotenoid by weight, so this is what the food is,
	// not a factor slip.
	{"carotene_beta", "Beta-carotene", UnitUg, GroupVitamin, 200000},
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
	// 200: royal jelly (CIQUAL alim_code 31108) publishes 133mg/100g, and
	// the rest of its B vitamins are just as extreme (105mg niacin, 150ug
	// B12) -- royal jelly is the richest known dietary source of
	// pantothenic acid and the literature agrees on 100-200mg/100g. The
	// same archive's energy drink (18354) publishes 135mg against ordinary
	// fortification levels for every other B vitamin in the same food,
	// which is why this ceiling was raised to admit royal jelly rather
	// than to cover that row too; that one food is excluded by id instead.
	{"pantothenate", "Pantothenic acid (B5)", UnitMg, GroupVitamin, 200},
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
