package main

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// CheckResult is the outcome of one verification check.
type CheckResult struct {
	Name   string
	Pass   bool
	Detail string
}

// atwaterTolerance is the fraction by which a food's declared energy may
// differ from its macro-derived estimate before it counts as suspect.
// Fibre, polyols and organic acids make a tight bound impossible.
const atwaterTolerance = 0.30

// atwaterMaxSuspectFraction is how many suspect foods the pack may contain
// before the check fails outright on the soft, fractional gate.
const atwaterMaxSuspectFraction = 0.10

// atwaterHardDeviation is the second, per-food gate: a single food this far
// off cannot be excused by averaging over a large pack. Over ~8,000 foods
// the fractional gate alone tolerates roughly 800 foods deviating past
// atwaterTolerance; a lone food off by 1000x still contributes only
// 0.0125% and the fractional gate alone would report PASS. This bound
// fails the build outright regardless of how large the pack is.
const atwaterHardDeviation = 1.0

// atwaterAshExemptionThreshold exempts a very-high-ash food from the hard
// gate only (it still counts toward the fractional gate below, so it
// stays visible in the reported percentage). Atwater arithmetic assumes
// carbohydrate-by-difference is mostly digestible carbohydrate; that
// breaks down for a food that is mostly inert mineral salts, where the
// "carbohydrate" left over after subtracting protein/fat/water/ash is
// largely non-caloric filler rather than anything metabolisable.
//
// Confirmed against real SR Legacy data rather than picked to make one
// check pass: "Leavening agents, baking powder, double-acting, sodium
// aluminum sulfate" (fdc_id 172803) is 67.3g/100g ash and is the only food
// in a real two-source, ~8,200-food build that fails this gate (108% off);
// it is also the highest-ash food anywhere near the failure boundary. The
// highest ash content among ordinary dietary foods in that same build —
// meat extender, miso, canned anchovy, dried milk, hard cheese — tops out
// at 13.13g/100g (fdc_id 174268), so 50 sits with nearly 4x margin above
// any real food's actual ash content and well below every confirmed
// mineral-dominated product (baking powder 46.4-71.8g, table salt/pure
// seasoning blends 99+g) that this exists to exempt.
const atwaterAshExemptionThreshold = 50.0

// runChecks runs every structural check over a built pack.
func runChecks(p format.Pack) []CheckResult {
	return []CheckResult{
		checkNonEmpty(p),
		checkVocabulary(p),
		checkEnergyPresent(p),
		checkRanges(p),
		checkMacroSum(p),
		checkAtwater(p),
		checkGolden(p),
		checkCrossSource(p),
		checkAttribution(p),
		checkSubNutrients(p),
		checkPortions(p),
	}
}

// checkNonEmpty fails a pack that carries no foods. Every other check
// degrades to a vacuous pass over an empty slice, so an empty or truncated
// pack must be caught explicitly rather than relying on the others to
// notice.
func checkNonEmpty(p format.Pack) CheckResult {
	if len(p.Foods) == 0 {
		return CheckResult{"non_empty", false,
			fmt.Sprintf("pack has 0 foods from %d sources", len(p.Sources))}
	}
	return CheckResult{"non_empty", true,
		fmt.Sprintf("%d foods from %d sources", len(p.Foods), len(p.Sources))}
}

// checkVocabulary compares the pack's nutrient key list against the
// binary's. Through the foodpack verify CLI this is defence-in-depth, not
// the primary guard: format.Read already rejects a pack whose
// NutrientKeys mismatch food.Keys() with ErrVocabularyMismatch before
// runChecks ever sees it, so verifyCmd never reaches this check with a
// mismatched pack. It still matters for any caller that constructs a
// format.Pack directly and calls runChecks without going through Read.
func checkVocabulary(p format.Pack) CheckResult {
	want := food.Keys()
	if len(p.NutrientKeys) != len(want) {
		return CheckResult{"vocabulary", false,
			fmt.Sprintf("pack has %d keys, binary has %d", len(p.NutrientKeys), len(want))}
	}
	for i, k := range want {
		if p.NutrientKeys[i] != k {
			return CheckResult{"vocabulary", false,
				fmt.Sprintf("slot %d is %q in pack, %q in binary", i, p.NutrientKeys[i], k)}
		}
	}
	return CheckResult{"vocabulary", true, fmt.Sprintf("%d keys match", len(want))}
}

// energyPresentMaxMissingFraction bounds how many foods in the pack may
// carry no energy_kcal value before this check fails.
//
// USDA Foundation Foods' own dataset does not always publish one under any
// of the three nutrient numbers usda.go looks at (208, and the 957/958
// Atwater-factor fallback): a real-data build turned up 58 foods with
// none of the three, confirmed directly against the source's own
// food_nutrient.csv rather than a downstream defect -- a
// "Salt, table, iodized" entry (0kcal is correct but apparently never
// recorded) and roughly fifty specialty dry-bean cultivar samples that
// read as a proximate-only research batch.
//
// CIQUAL brings 143 more (4.1% of its own rows) and CoFID 33 (1.1%),
// taking a six-source pack to 234 of 21,834, about 1.1%. CIQUAL's gap
// was checked for a recoverable second convention the way USDA's was, and
// there is none: of the 143 foods with no const_code 328, not one carries
// 332 or 333 either, so CIQUAL genuinely publishes no energy figure for
// them rather than publishing one this adapter fails to read.
//
// 0.02 (2%) keeps roughly the same headroom over the confirmed gap that
// 0.01 kept over the USDA-only one. It stays a real gate: the regression
// this check is for is a source's energy column silently going missing,
// and the smallest source here is AFCD at 1,588 rows -- 9.8% of the pack,
// five times the ceiling.
const energyPresentMaxMissingFraction = 0.02

func checkEnergyPresent(p format.Pack) CheckResult {
	missing := 0
	for _, f := range p.Foods {
		if _, ok := food.Decode(f.Nutrients)["energy_kcal"]; !ok {
			missing++
		}
	}
	frac := 0.0
	if len(p.Foods) > 0 {
		frac = float64(missing) / float64(len(p.Foods))
	}
	return CheckResult{"energy_present", frac <= energyPresentMaxMissingFraction,
		fmt.Sprintf("%d of %d foods have no energy value (%.1f%%)", missing, len(p.Foods), frac*100)}
}

func checkRanges(p format.Pack) CheckResult {
	for _, f := range p.Foods {
		if err := food.Validate(food.Decode(f.Nutrients)); err != nil {
			return CheckResult{"ranges", false,
				fmt.Sprintf("%s/%s (%s): %v", f.Source, f.SourceID, f.Name, err)}
		}
	}
	return CheckResult{"ranges", true, fmt.Sprintf("%d foods within plausible ranges", len(p.Foods))}
}

func checkMacroSum(p format.Pack) CheckResult {
	// Components of 100 g cannot sum to much more than 100 g. 105 was a
	// guess made before any real dataset had been seen; real SR Legacy data
	// raised it to 107. USDA measures protein, fat, water and ash
	// independently rather than computing them by difference, so cooking
	// (which concentrates nutrients as water evaporates) can legitimately
	// push their sum a little past 100 with no mapping error involved: SR
	// Legacy's "Fish, salmon, chinook, cooked, dry heat" (fdc_id 171999)
	// sums to 106.5, "Fish, herring, Pacific, cooked, dry heat" (174233) to
	// 105.33, and "Fish, yellowtail, mixed species, cooked, dry heat"
	// (174248) to 105.12 -- all three confirmed independently-measured, not
	// a column mapped onto the wrong canonical key.
	//
	// 110 once CoFID and AFCD are in the pack, for a reason that is
	// arithmetic rather than measurement: both state carbohydrate as
	// monosaccharide equivalents, which adds back the water a disaccharide
	// takes up on hydrolysis and so overstates the carbohydrate's own mass
	// by about 5%. On a food that is nearly all carbohydrate that is
	// several grams on its own -- CoFID's sago, tapioca, arrowroot and
	// buckwheat groats all land at 106.7-107.7, and the highest food in a
	// six-source build is cofid/16-428 "Cod, in batter, fried in sunflower
	// oil, takeaway" at 108.3, with AFCD's glucose syrup at 108.0. 21 foods
	// exceed 105 and none reach 109.
	//
	// 110 still catches what this check is for: a mapping that
	// double-counts fibre into carbohydrate lands far past it, and a
	// column read in the wrong unit is not close.
	const limit = 110.0
	for _, f := range p.Foods {
		prof := food.Decode(f.Nutrients)
		sum := 0.0
		for _, k := range []string{"protein", "fat", "carbohydrate", "water", "ash", "alcohol"} {
			sum += prof[k] // absent reads as 0, which only makes the check laxer
		}
		if sum > limit {
			return CheckResult{"macro_sum", false,
				fmt.Sprintf("%s/%s (%s): components sum to %.1f g per 100 g", f.Source, f.SourceID, f.Name, sum)}
		}
	}
	return CheckResult{"macro_sum", true, fmt.Sprintf("no food exceeds %.0f g of components per 100 g", limit)}
}

func checkAtwater(p format.Pack) CheckResult {
	checked, suspect := 0, 0
	var worst string
	worstDev := 0.0
	var hardFail string
	hardDev := 0.0

	for _, f := range p.Foods {
		prof := food.Decode(f.Nutrients)
		kcal, okE := prof["energy_kcal"]
		pro, okP := prof["protein"]
		carb, okC := prof["carbohydrate"]
		fat, okF := prof["fat"]
		if !okE || !okP || !okC || !okF || kcal < 20 {
			continue // too little energy for a ratio to mean anything
		}
		checked++

		// Sources do not agree on what "carbohydrate" counts or on what a
		// gram of fibre is worth, and both disagreements move the estimate
		// by more than this check's tolerance on a high-fibre food. USDA
		// states carbohydrate "by difference" -- total mass minus
		// everything else measured -- so its figure already contains the
		// fibre, and charging that fibre 4 kcal/g instead of 2 turns wheat
		// bran (66% out) and ground cinnamon (41%) into false suspects.
		// CoFID and CIQUAL state available carbohydrate instead, which
		// excludes fibre, so netting fibre back out of it subtracts
		// something that was never in it. On top of that, CoFID's declared
		// kcal gives non-starch polysaccharide no energy at all where EU
		// 1169/2011 gives fibre 2 kcal/g -- on dried kombu, 58.7 g of NSP,
		// that one convention is the difference between 43 kcal and 160.
		//
		// So the estimate is a band rather than a number: whichever
		// convention the source used, one of these three is the formula it
		// used, and the food is judged on the closest. That is not a
		// loophole. This check exists to catch a column read in the wrong
		// unit, and kilojoules read as kilocalories is 318% out -- every
		// candidate below misses that by a mile. When a food carries no
		// fibre figure all three collapse to the same plain formula.
		alc := prof["alcohol"]
		base := 4*pro + 9*fat + 7*alc
		fibre, hasFibre := prof["fibre"]
		netCarb := carb - fibre
		if netCarb < 0 {
			netCarb = 0 // a mapping error already caught elsewhere; don't let it go negative here too
		}
		ests := []float64{base + 4*carb} // available carbohydrate, fibre unenergised (CoFID)
		if hasFibre {
			ests = append(ests,
				base+4*netCarb+2*fibre, // by difference, fibre at 2 kcal/g (USDA)
				base+4*carb+2*fibre,    // available carbohydrate, fibre at 2 kcal/g (EU 1169/2011)
			)
		}
		est, dev := ests[0], math.Abs(ests[0]-kcal)/kcal
		for _, e := range ests[1:] {
			if d := math.Abs(e-kcal) / kcal; d < dev {
				est, dev = e, d
			}
		}
		if dev > atwaterTolerance {
			suspect++
			if dev > worstDev {
				worstDev, worst = dev, fmt.Sprintf("%s/%s (%s): declared %.0f kcal, macros imply %.0f", f.Source, f.SourceID, f.Name, kcal, est)
			}
		}
		// The hard gate assumes a normal food; a mineral-dominated one is
		// exempt from it specifically (see atwaterAshExemptionThreshold),
		// but still contributed to suspect/checked above, so it remains
		// visible in the reported percentage.
		if dev > atwaterHardDeviation && dev > hardDev && prof["ash"] < atwaterAshExemptionThreshold {
			hardDev, hardFail = dev, fmt.Sprintf("%s/%s (%s): declared %.0f kcal, macros imply %.0f (%.0f%% off)", f.Source, f.SourceID, f.Name, kcal, est, dev*100)
		}
	}

	if checked == 0 {
		return CheckResult{"atwater", true, "no food had all three macros; nothing to check"}
	}
	frac := float64(suspect) / float64(checked)
	detail := fmt.Sprintf("%d of %d checked foods (%.1f%%) deviate over %.0f%%",
		suspect, checked, frac*100, atwaterTolerance*100)
	if worst != "" {
		detail += "; worst: " + worst
	}
	pass := frac <= atwaterMaxSuspectFraction
	if hardFail != "" {
		pass = false
		detail += fmt.Sprintf("; HARD FAIL: a food deviates over %.0f%% (%s)", atwaterHardDeviation*100, hardFail)
	}
	return CheckResult{"atwater", pass, detail}
}

// checkAttribution proves every food can be joined to a licence.
//
// USDA is public domain, but CNF, CIQUAL, CoFID and AFCD are all open
// licences with an attribution condition. The attribution screen is built
// from p.Sources, so a food whose Source has no row there ships
// unattributed — a licensing defect, not a display one.
//
// This checked only the source-level SourceInfo table, never the per-food
// Licence/Region fields design section 2 makes part of food_ref itself
// (`licence` is a per-row field, not just a per-source one) — an adapter
// that declared a correct SourceInfo row but shipped every food with
// Licence: "" would have passed. The per-food loop below closes that.
func checkAttribution(p format.Pack) CheckResult {
	counted := map[string]int{}
	missingLicence := map[string]int{}
	missingRegion := map[string]int{}
	for _, f := range p.Foods {
		counted[f.Source]++
		if f.Licence == "" {
			missingLicence[f.Source]++
		}
		if f.Region == "" {
			missingRegion[f.Source]++
		}
	}
	declared := map[string]format.SourceInfo{}
	for _, s := range p.Sources {
		declared[s.Source] = s
	}

	var problems []string
	// Sorted so a pack with several problems reports them the same way
	// every run.
	for _, name := range sortedKeys(counted) {
		s, ok := declared[name]
		if !ok {
			problems = append(problems, fmt.Sprintf("%d food(s) from %q have no attribution row", counted[name], name))
			continue
		}
		if missing := missingAttributionFields(s); len(missing) > 0 {
			problems = append(problems, fmt.Sprintf("%q is missing %s", name, strings.Join(missing, ", ")))
		}
		if s.Rows != counted[name] {
			problems = append(problems, fmt.Sprintf("%q claims %d rows but the pack holds %d", name, s.Rows, counted[name]))
		}
		if n := missingLicence[name]; n > 0 {
			problems = append(problems, fmt.Sprintf("%d food(s) from %q have no per-food licence", n, name))
		}
		if n := missingRegion[name]; n > 0 {
			problems = append(problems, fmt.Sprintf("%d food(s) from %q have no per-food region", n, name))
		}
	}
	for _, s := range p.Sources {
		if counted[s.Source] == 0 {
			problems = append(problems, fmt.Sprintf("%q is attributed but contributed no foods", s.Source))
		}
	}

	if len(problems) > 0 {
		return CheckResult{"attribution", false, strings.Join(problems, "; ")}
	}
	return CheckResult{"attribution", true,
		fmt.Sprintf("%d source(s) attributed, every food joined", len(p.Sources))}
}

// missingAttributionFields names which of a SourceInfo's three required
// fields are empty, so a debugging session goes straight to the field an
// adapter forgot to set instead of re-reading all three.
func missingAttributionFields(s format.SourceInfo) []string {
	var missing []string
	if s.Licence == "" {
		missing = append(missing, "licence")
	}
	if s.Region == "" {
		missing = append(missing, "region")
	}
	if s.URL == "" {
		missing = append(missing, "url")
	}
	return missing
}

// subNutrientRelation is one internal-consistency rule: the numerators
// (measured independently of the denominator, e.g. individual fatty
// acids) may not sum to much more than the denominator they are part of.
//
// Floor is the minimum denominator value below which the ratio stops
// meaning anything — 0.01 g of saturated fat against 0.00 g of total fat
// is rounding noise, not a mapping error, exactly like crossSourceFloor
// above. A food whose denominator is missing, or any of whose numerators
// is missing, is skipped entirely: absent is not zero, and treating it as
// zero would only ever make this check laxer or noisier, never catch
// anything.
//
// Two gates, mirroring checkAtwater in this same file: HardMult is a
// single-food gate exactly like the original design and the first version
// of this check — it exists to catch one catastrophic outlier (a factor
// error on one food, or one column read in the wrong unit) but a flat
// hard bound wide enough to admit real independent-measurement variance
// cannot also catch a *systematic* error. A conversion-factor bug that
// scales an entire source's fatty acids (or shrinks its total fat) by,
// say, 1.5-2x would move virtually every food to somewhere in that range
// and sail under a hard ceiling picked to admit one 2.85x outlier,
// silently. SoftMult/SoftMaxSuspectFraction is the fractional gate that
// catches that shape of failure instead: it fires when too large a
// *fraction* of foods sit above a tight ratio, regardless of how far past
// it any single one goes. SoftMult == 0 disables the soft gate for a
// relation where the real distribution is already tight enough that the
// blind spot is negligible (fibre, retinol below).
type subNutrientRelation struct {
	Name        string // used in the failure message
	Numerators  []string
	Denominator string
	Floor       float64

	// Sources restricts a relation to the sources it is actually true
	// for; empty means every source. Not every relation between canonical
	// keys is a fact about food -- some are facts about one dataset's
	// conventions, and applying those to a source that uses a different
	// convention reports the convention as a defect. See the fibre
	// relation below, which is exact for carbohydrate-by-difference and
	// false by construction for available carbohydrate.
	Sources []string

	SoftMult               float64 // 0 disables the fractional gate
	SoftMaxSuspectFraction float64

	HardMult float64
}

// subNutrientRelations are checked against the real USDA-only build
// (8,202 foods) that this branch can currently produce; every constant
// below is derived from the measured distribution over that build, not
// picked in advance — see each relation's comment for the numbers.
//
// "vitamin_d + vitamin_e ..." and similar RE-vs-RAE style relationships
// are deliberately not here: the four below are the ones that held (with
// a defensible floor and margin) against real data; nothing else from the
// design's suggested set survived contact with it — see the fix-wave
// report for what was tried and dropped.
var subNutrientRelations = []subNutrientRelation{
	{
		// USDA measures fatty acid subtypes independently of total fat
		// rather than deriving one from the other, so they do not sum
		// exactly to it even in good data. Measured distribution over
		// 5,534 real foods with fat >= 1g and all three subtypes present:
		// 12 (0.22%) exceed 1.05x, 10 (0.18%) exceed 1.1x, 7 (0.13%)
		// exceed 1.2x, 2 (0.04%) exceed 1.5x, and exactly 1 (0.02%)
		// exceeds 2.0x — usda_sr/174513 "Turkey, retail parts, breast,
		// meat only, with added solution, raw" at 2.85x, an "added
		// solution" (brine-injected) product, a category USDA is known to
		// carry some nutrient values for by retention/imputation rather
		// than direct proportional measurement of the diluted product.
		// The next worst, usda_sr/170603 "Beef, chuck, under blade pot
		// roast..." (1.67x), is an ordinary raw cut with no such
		// explanation.
		//
		// A flat hard bound wide enough to admit 2.85x (anything under
		// ~3x) would let a systematic 1.5-2x scaling bug — the kind that
		// moves virtually every food together, not one outlier — sail
		// through silently: 99.8% of real foods sit under 1.05x, so a
		// bug that pushed most foods to even 1.2x would be enormous
		// relative to reality but invisible to a hard-only gate. SoftMult
		// 1.1x with a 0.5% suspect ceiling closes that: real data trips
		// it at 0.18% (10/5,534), comfortably under the ceiling, while a
		// systematic bug affecting more than a tiny fraction of foods
		// fails outright. HardMult stays at 3.0 so the turkey — a single,
		// explained outlier — still passes on its own without being
		// excluded by name.
		//
		// Re-measured over the six-source build: 55 of 14,100 (0.390%),
		// still passing but with only 1.28x headroom rather than the 2.8x
		// the USDA-only figure gave. The extra suspects are spread across
		// CNF, CoFID and CIQUAL rather than concentrated in one of them,
		// which is what a real convention difference would look like and
		// not what a mapping bug would. The ceiling is left where it is
		// deliberately: 0.5% is still the right question to ask, and the
		// next source to arrive should be a decision someone makes with
		// this number in front of them rather than one already made here.
		Name:                   "fat_saturated + fat_monounsaturated + fat_polyunsaturated <= fat",
		Numerators:             []string{"fat_saturated", "fat_monounsaturated", "fat_polyunsaturated"},
		Denominator:            "fat",
		Floor:                  1.0,
		SoftMult:               1.1,
		SoftMaxSuspectFraction: 0.005,
		HardMult:               3.0,
	},
	{
		// Sugars and starch are likewise measured separately from
		// carbohydrate-by-difference. Measured distribution over 1,019
		// real foods with carbohydrate >= 1g and both present: 6 (0.59%)
		// exceed 1.05x, 3 (0.29%) exceed 1.1x, 2 (0.20%) exceed 1.2x, and
		// none exceed 1.35x. Worst case: usda_sr/173327 "HOT POCKETS Ham
		// 'N Cheese Stuffed Sandwich, frozen" at 1.302x, a composite
		// prepared dish where the two measurements come from different
		// methods.
		//
		// Same blind spot as the fat relation above, smaller stakes: a
		// hard-only gate would admit a systematic bug that moved most
		// foods to 1.2-1.3x. SoftMult 1.1x with a 1.0% suspect ceiling
		// closes it.
		//
		// Re-measured over the six-source build (6,152 foods with
		// carbohydrate >= 1g and both components present): 13 (0.211%)
		// exceed 1.1x and none exceed 1.5x. The soft gate sits ~4.7x under
		// its ceiling. HardMult moved 1.35 -> 1.5 for the
		// two foods above the old bound, both composite dishes where the
		// components and the total come from different methods:
		// ciqual/30155 "Merguez sausage, beef and mutton, cooked" at
		// 1.444x (2.6 g of sugars and starch against 1.8 g of
		// carbohydrate -- 0.8 g, which is rounding at this magnitude) and
		// cofid/15-889 "Tomatoes, stuffed with vegetables" at 1.393x.
		Name:                   "sugars + starch <= carbohydrate",
		Numerators:             []string{"sugars", "starch"},
		Denominator:            "carbohydrate",
		Floor:                  1.0,
		SoftMult:               1.1,
		SoftMaxSuspectFraction: 0.01,
		HardMult:               1.5,
	},
	{
		// Fibre is a component of carbohydrate-by-difference by
		// definition (it is not measured independently and subtracted
		// out the way sugars/starch are), so this one holds exactly: 0
		// violations across every one of the 7,403 real USDA foods
		// carrying both keys, and the single closest real food
		// (usda_sr/167682 "Pectin, liquid") sits at ratio 1.0000 -- fibre
		// equal to carbohydrate, not exceeding it. No soft gate: with the
		// relation already exact by definition, a fractional gate has no
		// real distribution to distinguish from a systematic error and
		// would add nothing but a second constant to maintain. No floor
		// and no margin beyond the design's own 1.0 were needed.
		//
		// Restricted to USDA because the definition it rests on is USDA's.
		// CoFID, CIQUAL and AFCD all publish *available* carbohydrate,
		// which excludes fibre, so for them the two figures are disjoint
		// and fibre routinely exceeds carbohydrate with nothing wrong at
		// all: AFCD's uncooked psyllium (F007502) is 88.7 g of fibre
		// against 1.0 g of available carbohydrate, and dried curry powder
		// is 53.2 against 2.6 in both AFCD and CIQUAL. Run pack-wide, this
		// relation calls 296 foods (2.9%) defective and every one of them
		// is correct. It is a fact about a convention, not about food.
		Name:        "fibre <= carbohydrate",
		Numerators:  []string{"fibre"},
		Denominator: "carbohydrate",
		Sources:     []string{"usda_foundation", "usda_sr"},
		Floor:       0,
		HardMult:    1.0,
	},
	{
		// Retinol is one component that feeds into vitamin_a_rae (the
		// other being carotenes divided by their RAE conversion factors),
		// so it cannot exceed RAE by more than measurement noise. Real
		// worst case over 4,439 real foods: usda_sr/173540 "Infant
		// formula, MEAD JOHNSON, PROSOBEE, with iron, ready-to-feed" at
		// 1.0172x (59ug retinol against 58ug RAE) -- already close enough
		// to the design's own 1.1 hard bound that the blind spot a soft
		// gate would close is negligible; not worth a second constant.
		// Floor 1.0ug excludes usda_sr/167889 "Pork, fresh, loin, center
		// rib..." where vitamin_a_rae rounds to 0ug against 2ug of
		// retinol -- noise between two near-zero figures, not a real
		// disagreement.
		Name:        "retinol <= vitamin_a_rae",
		Numerators:  []string{"retinol"},
		Denominator: "vitamin_a_rae",
		Floor:       1.0,
		HardMult:    1.1,
	},
}

// checkSubNutrients asserts that, within a single food, sub-nutrients
// measured independently of a total do not sum to much more than that
// total. Unlike every other check here, this one is a pure function of
// the pack itself — it needs no second source to compare against, so it
// is exercised by today's USDA-only build rather than waiting on a
// second real source to exist.
//
// It exists because every other range check in this file only rejects a
// value for being too LARGE (food.Validate rejects v > n.Max). A
// conversion factor wrong in the shrinking direction — a 0.001 applied to
// a column already in grams, milligrams read as grams — produces values a
// thousandfold too small and sails through every other check unnoticed.
// Scaling one side of one of these relationships out of proportion to the
// other, in either direction, is exactly what this catches: a hard gate
// for one outlier food, a soft gate (where the relation has one — see
// subNutrientRelation's doc comment) for a systematic error moving many
// foods together.
// appliesTo reports whether this relation is checked for a food from the
// named source. A relation with no Sources applies to all of them.
func (r subNutrientRelation) appliesTo(source string) bool {
	if len(r.Sources) == 0 {
		return true
	}
	for _, s := range r.Sources {
		if s == source {
			return true
		}
	}
	return false
}

func checkSubNutrients(p format.Pack) CheckResult {
	var details []string
	for _, rel := range subNutrientRelations {
		checked, suspect := 0, 0
		var worstSoftDesc string
		worstSoftRatio := 0.0
		var hardDesc string
		hardRatio := 0.0

		for _, f := range p.Foods {
			if !rel.appliesTo(f.Source) {
				continue
			}
			prof := food.Decode(f.Nutrients)
			denom, ok := prof[rel.Denominator]
			if !ok || denom < rel.Floor {
				continue
			}
			sum := 0.0
			complete := true
			for _, k := range rel.Numerators {
				v, ok := prof[k]
				if !ok {
					complete = false
					break
				}
				sum += v
			}
			if !complete {
				continue
			}
			checked++
			ratio := sum / denom

			if rel.SoftMult > 0 && ratio > rel.SoftMult {
				suspect++
				if ratio > worstSoftRatio {
					worstSoftRatio = ratio
					worstSoftDesc = fmt.Sprintf("%s/%s (%s): %.3fx", f.Source, f.SourceID, f.Name, ratio)
				}
			}
			if ratio > rel.HardMult && ratio > hardRatio {
				hardRatio = ratio
				hardDesc = fmt.Sprintf("%s/%s (%s): %s = %.3f, %s sum to %.3f (%.3fx)",
					f.Source, f.SourceID, f.Name, rel.Denominator, denom,
					strings.Join(rel.Numerators, "+"), sum, ratio)
			}
		}

		if hardDesc != "" {
			return CheckResult{"sub_nutrients", false, fmt.Sprintf(
				"%s: a single food deviates over %.2fx: %s", rel.Name, rel.HardMult, hardDesc)}
		}
		if rel.SoftMult > 0 {
			frac := 0.0
			if checked > 0 {
				frac = float64(suspect) / float64(checked)
			}
			if frac > rel.SoftMaxSuspectFraction {
				return CheckResult{"sub_nutrients", false, fmt.Sprintf(
					"%s: %d of %d checked foods (%.3f%%) exceed %.2fx, over the %.2f%% ceiling; worst: %s",
					rel.Name, suspect, checked, frac*100, rel.SoftMult, rel.SoftMaxSuspectFraction*100, worstSoftDesc)}
			}
			details = append(details, fmt.Sprintf(
				"%s: %d checked, %d (%.3f%%) exceed %.2fx (soft ceiling %.2f%%), none exceed %.2fx (hard)",
				rel.Name, checked, suspect, frac*100, rel.SoftMult, rel.SoftMaxSuspectFraction*100, rel.HardMult))
		} else {
			details = append(details, fmt.Sprintf("%s: %d checked, none exceed %.2fx", rel.Name, checked, rel.HardMult))
		}
	}
	return CheckResult{"sub_nutrients", true, strings.Join(details, "; ")}
}

// portionMaxPlausibleGrams bounds a single household-measure portion
// before it counts as implausible. Nothing in the pipeline had ever read
// Portions or DefaultServingG before this check: a wrong portion weight
// is the most user-visible error the pack can carry, because it
// multiplies every diary entry logged from that food, and arithmetic like
// CNF's `factor * 100` is exactly the kind of thing that goes wrong
// quietly.
//
// Confirmed against the real USDA build rather than picked in advance:
// the largest real portion in the 8,202-food build is usda_sr/172868
// "Turkey, whole, meat only, with added solution, raw", whose "1 bird"
// portion is 5,717g -- a real whole turkey is plausibly that heavy. The
// next-largest real portions (other whole birds and roasts) run
// 3,952-5,717g for the top ten. 10,000g (10kg) sits with nearly 2x margin above the
// largest confirmed real portion while still failing outright on the
// kind of error this exists to catch: CNF's serving-size arithmetic is
// `factor * 100`, so a factor mistakenly left in a per-kg rather than
// per-100g unit would land here immediately.
const portionMaxPlausibleGrams = 10000.0

// checkPortions asserts every portion is a plausible positive weight, and
// that DefaultServingG (denormalized for fast list rendering) actually
// agrees with the portion list it was denormalized from.
func checkPortions(p format.Pack) CheckResult {
	checked := 0
	for _, f := range p.Foods {
		for _, port := range f.Portions {
			checked++
			if port.Grams <= 0 {
				return CheckResult{"portions", false, fmt.Sprintf(
					"%s/%s (%s): portion %q is %g g, not greater than 0",
					f.Source, f.SourceID, f.Name, port.Label, port.Grams)}
			}
			if port.Grams > portionMaxPlausibleGrams {
				return CheckResult{"portions", false, fmt.Sprintf(
					"%s/%s (%s): portion %q is %g g, over the %g g plausible ceiling",
					f.Source, f.SourceID, f.Name, port.Label, port.Grams, portionMaxPlausibleGrams)}
			}
		}
		if len(f.Portions) > 0 && f.DefaultServingG != f.Portions[0].Grams {
			return CheckResult{"portions", false, fmt.Sprintf(
				"%s/%s (%s): DefaultServingG is %g g but the first portion (%q) is %g g",
				f.Source, f.SourceID, f.Name, f.DefaultServingG, f.Portions[0].Label, f.Portions[0].Grams)}
		}
	}
	return CheckResult{"portions", true,
		fmt.Sprintf("%d portions across %d foods within bounds", checked, len(p.Foods))}
}

func sortedKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
