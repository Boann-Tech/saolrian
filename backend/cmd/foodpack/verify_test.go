package main

import (
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func packOf(profiles ...food.Profile) format.Pack {
	p := format.Pack{Version: "test", NutrientKeys: food.Keys()}
	for i, prof := range profiles {
		p.Foods = append(p.Foods, format.RefFood{
			Source: "usda_sr", SourceID: string(rune('a' + i)),
			Name: "Test food", Nutrients: food.Encode(prof),
		})
	}
	p.Sources = []format.SourceInfo{{Source: "usda_sr", Rows: len(p.Foods)}}
	return p
}

func result(t *testing.T, p format.Pack, name string) CheckResult {
	t.Helper()
	for _, r := range runChecks(p) {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("check %q was not run", name)
	return CheckResult{}
}

func TestEnergyPresentCheck(t *testing.T) {
	ok := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	if !result(t, ok, "energy_present").Pass {
		t.Error("energy_present failed on a pack where every food has energy")
	}

	bad := packOf(food.Profile{"protein": 1})
	if result(t, bad, "energy_present").Pass {
		t.Error("energy_present passed on a food with no energy value")
	}
}

func TestRangesCheckCatchesUnitError(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89, "iron": 300000})
	if result(t, bad, "ranges").Pass {
		t.Error("ranges passed on an implausible iron value")
	}
}

func TestAtwaterCheck(t *testing.T) {
	// 4*1.09 + 4*22.8 + 9*0.33 = 98.5 kcal vs a declared 89: ~10% off, fine.
	ok := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33,
	})
	if !result(t, ok, "atwater").Pass {
		t.Error("atwater failed on a plausible banana")
	}

	// Fat scaled by 10 — the classic unit slip Atwater is here to catch.
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 33,
	})
	if result(t, bad, "atwater").Pass {
		t.Error("atwater passed on a food whose macros cannot produce its energy")
	}
}

func TestMacroSumCheck(t *testing.T) {
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 60, "carbohydrate": 60, "fat": 60, "water": 60,
	})
	if result(t, bad, "macro_sum").Pass {
		t.Error("macro_sum passed on components totalling far more than 100 g")
	}
}

func TestVocabularyCheck(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89})
	bad.NutrientKeys = []string{"energy_kcal"}
	if result(t, bad, "vocabulary").Pass {
		t.Error("vocabulary passed on a pack built with a stale key list")
	}
}
