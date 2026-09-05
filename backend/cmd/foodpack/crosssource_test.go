package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
)

func bananaProfile(kcal float64) food.Profile {
	return food.Profile{"energy_kcal": kcal, "protein": 1.1, "fat": 0.3, "carbohydrate": 22}
}

var bananaAnchors = []anchorEntry{
	{Anchor: "banana", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)^bananas, raw$`)},
	{Anchor: "banana", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)^banana, raw$`)},
	{Anchor: "banana", Source: "afcd", NameRegex: regexp.MustCompile(`(?i)^banana, cavendish`)},
}

func TestCrossSourceAcceptsNormalVariation(t *testing.T) {
	p := goldenPackOf([]string{"usda_sr", "cnf", "afcd"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		goldenFoodOf("cnf", "2", "Banana, raw", bananaProfile(89)),
		goldenFoodOf("afcd", "3", "Banana, cavendish, peeled, raw", bananaProfile(94)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if !got.Pass {
		t.Fatalf("check failed on ordinary between-lab variation: %s", got.Detail)
	}
}

// The bug this whole check exists for: kilojoules shipped as kilocalories.
func TestCrossSourceCatchesKilojouleError(t *testing.T) {
	p := goldenPackOf([]string{"usda_sr", "cnf", "afcd"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		goldenFoodOf("cnf", "2", "Banana, raw", bananaProfile(89)),
		goldenFoodOf("afcd", "3", "Banana, cavendish, peeled, raw", bananaProfile(395)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if got.Pass {
		t.Fatal("a source 4.184x out must fail")
	}
	for _, want := range []string{"afcd", "energy_kcal"} {
		if !strings.Contains(got.Detail, want) {
			t.Errorf("detail %q does not name %q", got.Detail, want)
		}
	}
}

// Two sources is enough to compare; one is not. A single-source pack is a
// legitimate state during development and must not fail the build.
func TestCrossSourceSkipsWhenOnlyOneSourceHasTheFood(t *testing.T) {
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if !got.Pass {
		t.Fatalf("a single-source pack must pass: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "1 source") {
		t.Errorf("detail should say why nothing was compared: %q", got.Detail)
	}
}

// An anchor whose source is in the pack but whose regex matches nothing is
// a drifted anchor. Passing silently would let the check quietly compare
// nothing at all.
func TestCrossSourceFailsOnDriftedAnchor(t *testing.T) {
	p := goldenPackOf([]string{"usda_sr", "cnf"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		goldenFoodOf("cnf", "2", "Banane crue", bananaProfile(89)), // name moved
	)
	got := evalCrossSource(p, bananaAnchors)
	if got.Pass {
		t.Fatal("an anchor matching no food in a present source must fail")
	}
	if !strings.Contains(got.Detail, "cnf") {
		t.Errorf("detail %q does not name the drifted source", got.Detail)
	}
}

// Near zero a relative comparison is meaningless: 0.1 g and 0.3 g of fat
// differ by 200% and both are "no fat".
func TestCrossSourceIgnoresNearZeroValues(t *testing.T) {
	lean := func(fat float64) food.Profile {
		return food.Profile{"energy_kcal": 110, "protein": 23, "fat": fat, "carbohydrate": 0}
	}
	anchors := []anchorEntry{
		{Anchor: "chicken", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)^chicken`)},
		{Anchor: "chicken", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)^chicken`)},
	}
	p := goldenPackOf([]string{"usda_sr", "cnf"},
		goldenFoodOf("usda_sr", "1", "Chicken breast, raw", lean(0.1)),
		goldenFoodOf("cnf", "2", "Chicken breast, raw", lean(0.4)),
	)
	if got := evalCrossSource(p, anchors); !got.Pass {
		t.Fatalf("near-zero values must not fail the check: %s", got.Detail)
	}
}

// A regex matching several foods must resolve the same way on every run.
func TestCrossSourceIsDeterministic(t *testing.T) {
	anchors := []anchorEntry{
		{Anchor: "banana", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`)},
		{Anchor: "banana", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)banana`)},
	}
	p := goldenPackOf([]string{"usda_sr", "cnf"},
		goldenFoodOf("usda_sr", "9", "Bananas, dehydrated", bananaProfile(346)),
		goldenFoodOf("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		goldenFoodOf("cnf", "2", "Banana, raw", bananaProfile(89)),
	)
	for i := 0; i < 5; i++ {
		// SourceID 1 sorts below 9, so the raw banana is always chosen and
		// the dehydrated one never decides the outcome.
		if got := evalCrossSource(p, anchors); !got.Pass {
			t.Fatalf("run %d: %s", i, got.Detail)
		}
	}
}

func TestCheckedInAnchorTableParses(t *testing.T) {
	entries, err := loadAnchorTable()
	if err != nil {
		t.Fatalf("loadAnchorTable: %v", err)
	}
	byAnchor := map[string]int{}
	for _, e := range entries {
		byAnchor[e.Anchor]++
	}
	if len(byAnchor) < 3 {
		t.Errorf("got %d anchor foods, want at least 3", len(byAnchor))
	}
	for anchor, n := range byAnchor {
		// An anchor naming one source can never compare anything.
		if n < 2 {
			t.Errorf("anchor %q names only %d source(s)", anchor, n)
		}
	}
}

func TestParseAnchorTableRejectsBadRows(t *testing.T) {
	for name, body := range map[string]string{
		"empty anchor": "anchor,source,name_regex,note\n,usda_sr,x,\n",
		"empty source": "anchor,source,name_regex,note\nbanana,,x,\n",
		"bad regex":    "anchor,source,name_regex,note\nbanana,usda_sr,[unclosed,\n",
		"duplicate":    "anchor,source,name_regex,note\nbanana,usda_sr,a,\nbanana,usda_sr,b,\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseAnchorTable(strings.NewReader(body)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}
