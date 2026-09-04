package main

import (
	"fmt"
	"math"

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
// before the check fails outright.
const atwaterMaxSuspectFraction = 0.10

// runChecks runs every structural check over a built pack.
func runChecks(p format.Pack) []CheckResult {
	return []CheckResult{
		checkNonEmpty(p),
		checkVocabulary(p),
		checkEnergyPresent(p),
		checkRanges(p),
		checkMacroSum(p),
		checkAtwater(p),
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

func checkEnergyPresent(p format.Pack) CheckResult {
	missing := 0
	for _, f := range p.Foods {
		if _, ok := food.Decode(f.Nutrients)["energy_kcal"]; !ok {
			missing++
		}
	}
	return CheckResult{"energy_present", missing == 0,
		fmt.Sprintf("%d of %d foods have no energy value", missing, len(p.Foods))}
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
	// Components of 100 g cannot sum to much more than 100 g. 105 allows for
	// independent rounding across a dataset's own columns.
	const limit = 105.0
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
	return CheckResult{"macro_sum", true, "no food exceeds 105 g of components per 100 g"}
}

func checkAtwater(p format.Pack) CheckResult {
	checked, suspect := 0, 0
	var worst string
	worstDev := 0.0

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
		est := 4*pro + 4*carb + 9*fat + 7*prof["alcohol"]
		dev := math.Abs(est-kcal) / kcal
		if dev > atwaterTolerance {
			suspect++
			if dev > worstDev {
				worstDev, worst = dev, fmt.Sprintf("%s/%s (%s): declared %.0f kcal, macros imply %.0f", f.Source, f.SourceID, f.Name, kcal, est)
			}
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
	return CheckResult{"atwater", frac <= atwaterMaxSuspectFraction, detail}
}
