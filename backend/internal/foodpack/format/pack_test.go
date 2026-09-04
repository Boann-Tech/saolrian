package format

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/boanntech/saolrian/backend/internal/food"
)

func samplePack() Pack {
	return Pack{
		Version:      "2026.09-test",
		BuiltAt:      time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC),
		NutrientKeys: food.Keys(),
		Sources: []SourceInfo{
			{Source: "usda_sr", Region: "us", Licence: "public-domain",
				URL: "https://fdc.nal.usda.gov/", Rows: 1},
		},
		Foods: []RefFood{{
			Source: "usda_sr", SourceID: "09040", Region: "us",
			Licence: "public-domain", Name: "Bananas, raw",
			SearchText: "bananas raw",
			Nutrients:  food.Encode(food.Profile{"energy_kcal": 89, "protein": 1.09}),
			Portions:   []Portion{{Label: "1 medium", Grams: 118}},
			DefaultServingG: 118,
		}},
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := Write(&buf, samplePack()); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("Write produced no bytes")
	}

	got, err := Read(&buf)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Version != "2026.09-test" {
		t.Errorf("Version = %q", got.Version)
	}
	if len(got.Foods) != 1 {
		t.Fatalf("Foods len = %d, want 1", len(got.Foods))
	}
	f := got.Foods[0]
	if f.Name != "Bananas, raw" || f.SourceID != "09040" {
		t.Errorf("food round trip wrong: %+v", f)
	}
	if len(f.Portions) != 1 || f.Portions[0].Grams != 118 {
		t.Errorf("portions round trip wrong: %+v", f.Portions)
	}
	prof := food.Decode(f.Nutrients)
	if prof["energy_kcal"] != 89 {
		t.Errorf("energy_kcal = %v, want 89", prof["energy_kcal"])
	}
	if _, ok := prof["iron"]; ok {
		t.Error("absent nutrient survived the pack round trip")
	}
}

func TestReadRejectsVocabularyMismatch(t *testing.T) {
	p := samplePack()
	p.NutrientKeys = []string{"energy_kcal", "protein"} // stale vocabulary

	var buf bytes.Buffer
	if err := Write(&buf, p); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := Read(&buf); !errors.Is(err, ErrVocabularyMismatch) {
		t.Fatalf("Read error = %v, want ErrVocabularyMismatch", err)
	}
}

func TestReadRejectsGarbage(t *testing.T) {
	if _, err := Read(bytes.NewReader([]byte("not a pack"))); err == nil {
		t.Fatal("Read accepted garbage input")
	}
}
