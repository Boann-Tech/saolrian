package food

import "testing"

func TestVocabularyKeysAreUniqueAndNonEmpty(t *testing.T) {
	seen := map[string]bool{}
	for i, n := range Nutrients {
		if n.Key == "" {
			t.Fatalf("nutrient %d has an empty key", i)
		}
		if seen[n.Key] {
			t.Fatalf("duplicate nutrient key %q", n.Key)
		}
		seen[n.Key] = true
		if n.Max <= 0 {
			t.Errorf("%s: Max must be positive, got %v", n.Key, n.Max)
		}
		switch n.Unit {
		case UnitKcal, UnitG, UnitMg, UnitUg:
		default:
			t.Errorf("%s: unknown unit %q", n.Key, n.Unit)
		}
	}
}

func TestIndexRoundTrips(t *testing.T) {
	for want, n := range Nutrients {
		got, ok := Index(n.Key)
		if !ok {
			t.Fatalf("Index(%q) not found", n.Key)
		}
		if got != want {
			t.Errorf("Index(%q) = %d, want %d", n.Key, got, want)
		}
	}
	if _, ok := Index("not_a_nutrient"); ok {
		t.Error("Index returned ok for an unknown key")
	}
}

func TestEnergyIsFirst(t *testing.T) {
	// Encoding order is part of the pack format; energy staying at slot 0
	// is a cheap canary for an accidental reordering.
	if Nutrients[0].Key != "energy_kcal" {
		t.Fatalf("slot 0 = %q, want energy_kcal", Nutrients[0].Key)
	}
}

func TestKeysMatchNutrientOrder(t *testing.T) {
	ks := Keys()
	if len(ks) != len(Nutrients) {
		t.Fatalf("Keys() len = %d, want %d", len(ks), len(Nutrients))
	}
	for i, k := range ks {
		if k != Nutrients[i].Key {
			t.Errorf("Keys()[%d] = %q, want %q", i, k, Nutrients[i].Key)
		}
	}
}
