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
// read as a proximate-only research batch. 0.01 (1%) sits comfortably
// above that confirmed gap (58 of 8,201 foods, ~0.7%) while still failing
// loudly on a mapping regression that took out a meaningfully larger
// slice.
const energyPresentMaxMissingFraction = 0.01

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
	// a column mapped onto the wrong canonical key. 107 still catches what
	// this check is for: a mapping that double-counts fibre into
	// carbohydrate lands well past 110.
	const limit = 107.0
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
	return CheckResult{"macro_sum", true, "no food exceeds 107 g of components per 100 g"}
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

		// USDA (and every other source's) carbohydrate is "by difference":
		// total mass minus everything else measured, so it includes fibre.
		// Fibre contributes roughly 2 kcal/g, not the 4 kcal/g of digestible
		// carbohydrate, and treating it as digestible turns ordinary
		// high-fibre foods (wheat bran, ground cinnamon) into false
		// suspects — on real data wheat bran deviates 66% and ground
		// cinnamon 41% under the naive formula. Net the fibre out of
		// carbohydrate when it is present; fall back to the plain formula
		// when it is absent, since then there is nothing to correct for.
		est := 4*pro + 4*carb + 9*fat + 7*prof["alcohol"]
		if fibre, ok := prof["fibre"]; ok {
			netCarb := carb - fibre
			if netCarb < 0 {
				netCarb = 0 // a mapping error already caught elsewhere; don't let it go negative here too
			}
			est = 4*pro + 4*netCarb + 2*fibre + 9*fat + 7*prof["alcohol"]
		}

		dev := math.Abs(est-kcal) / kcal
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
type subNutrientRelation struct {
	Name        string // used in the failure message
	Numerators  []string
	Denominator string
	Mult        float64
	Floor       float64
}

// subNutrientRelations are checked against the real USDA-only build
// (8,202 foods) that this branch can currently produce; each Mult/Floor
// pair is the smallest that lets every food in that build pass, with a
// small margin, not a value picked in advance. This is a hard check in
// the style of checkRanges: any violation fails the whole build on the
// first food found, so these bounds must actually hold.
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
		// exactly to it even in good data. Confirmed worst case in the
		// real build: usda_sr/174513 "Turkey, retail parts, breast, meat
		// only, with added solution, raw" sums to 7.213g across the three
		// subtypes against 2.53g of total fat (2.85x) — an "added
		// solution" (brine-injected) product, a category USDA is known to
		// carry some nutrient values for by retention/imputation rather
		// than direct proportional measurement of the diluted product.
		// The next worst, usda_sr/170603 "Beef, chuck, under blade pot
		// roast..." (1.67x), is an ordinary raw cut with no such
		// explanation, so the margin is real headroom, not just a
		// one-food carve-out. 3.0 clears both with room, while still
		// failing outright on the kind of order-of-magnitude factor error
		// (a forgotten mg->g conversion, a 0.001 applied to the wrong
		// column) this check exists to catch. Floor 1.0g: below that,
		// e.g. "Beverages, Orange juice drink" at 0.00g fat against
		// 0.02g of summed subtypes, the comparison is rounding noise
		// between two near-zero figures.
		Name:        "fat_saturated + fat_monounsaturated + fat_polyunsaturated <= fat",
		Numerators:  []string{"fat_saturated", "fat_monounsaturated", "fat_polyunsaturated"},
		Denominator: "fat",
		Mult:        3.0,
		Floor:       1.0,
	},
	{
		// Sugars and starch are likewise measured separately from
		// carbohydrate-by-difference. Confirmed worst case:
		// usda_sr/173327 "HOT POCKETS Ham 'N Cheese Stuffed Sandwich,
		// frozen" sums to 32.15g against 24.69g of carbohydrate (1.30x),
		// a composite prepared dish where the two measurements come from
		// different methods. 1.35 clears the real build with a small
		// margin. Floor 1.0g excludes trace-level foods such as
		// usda_sr/171528 "Turkey, retail parts, breast, meat and skin,
		// raw" (0.01g summed against 0.00g carbohydrate).
		Name:        "sugars + starch <= carbohydrate",
		Numerators:  []string{"sugars", "starch"},
		Denominator: "carbohydrate",
		Mult:        1.35,
		Floor:       1.0,
	},
	{
		// Fibre is a component of carbohydrate-by-difference by
		// definition (it is not measured independently and subtracted
		// out the way sugars/starch are), so this one holds exactly: 0
		// violations across every one of the 7,403 real foods carrying
		// both keys. No floor and no margin beyond the design's own 1.0
		// were needed.
		Name:        "fibre <= carbohydrate",
		Numerators:  []string{"fibre"},
		Denominator: "carbohydrate",
		Mult:        1.0,
		Floor:       0,
	},
	{
		// Retinol is one component that feeds into vitamin_a_rae (the
		// other being carotenes divided by their RAE conversion factors),
		// so it cannot exceed RAE by more than measurement noise. Holds
		// with 0 violations across 4,439 real foods at the design's own
		// 1.1. Floor 1.0ug excludes usda_sr/167889 "Pork, fresh, loin,
		// center rib..." where vitamin_a_rae rounds to 0ug against 2ug of
		// retinol — noise between two near-zero figures, not a real
		// disagreement.
		Name:        "retinol <= vitamin_a_rae",
		Numerators:  []string{"retinol"},
		Denominator: "vitamin_a_rae",
		Mult:        1.1,
		Floor:       1.0,
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
// other, in either direction, is exactly what this catches.
func checkSubNutrients(p format.Pack) CheckResult {
	checked := 0
	for _, f := range p.Foods {
		prof := food.Decode(f.Nutrients)
		for _, rel := range subNutrientRelations {
			denom, ok := prof[rel.Denominator]
			if !ok {
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
			if denom < rel.Floor {
				continue
			}
			checked++
			if sum > denom*rel.Mult {
				return CheckResult{"sub_nutrients", false, fmt.Sprintf(
					"%s/%s (%s): %s but %s = %.3f and %s sum to %.3f",
					f.Source, f.SourceID, f.Name, rel.Name, rel.Denominator, denom,
					strings.Join(rel.Numerators, "+"), sum)}
			}
		}
	}
	return CheckResult{"sub_nutrients", true,
		fmt.Sprintf("%d relation checks held across %d food(s)", checked, len(p.Foods))}
}

func sortedKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
