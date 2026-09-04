package source

import (
	"strings"
	"testing"
)

const goodCSV = `source_code,canonical_key,factor,note
208,energy_kcal,1,kcal
303,iron,1,mg
318,-,1,vitamin A IU superseded by RAE
999,calcium,0.001,source reports ug; canonical is mg
`

func TestLoadMappingApplies(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(goodCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}

	key, v, ok := m.Apply("208", 89)
	if !ok || key != "energy_kcal" || v != 89 {
		t.Errorf("Apply(208, 89) = %q, %v, %v", key, v, ok)
	}

	key, v, ok = m.Apply("999", 2000)
	if !ok || key != "calcium" || v != 2 {
		t.Errorf("Apply(999, 2000) = %q, %v, %v; want calcium, 2, true", key, v, ok)
	}
}

func TestIgnoredCodesAreKnownButNotApplied(t *testing.T) {
	m, _ := LoadMapping(strings.NewReader(goodCSV))
	if !m.Known("318") {
		t.Error("an explicitly ignored code must count as known")
	}
	if _, _, ok := m.Apply("318", 5); ok {
		t.Error("an ignored code must not produce a value")
	}
	if m.Known("12345") {
		t.Error("an unlisted code must not count as known")
	}
}

func TestLoadMappingRejectsUnknownCanonicalKey(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n1,unobtainium,1,\n"))
	if err == nil {
		t.Fatal("expected an error for an unknown canonical key")
	}
}

func TestLoadMappingRejectsDuplicateSourceCode(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n208,energy_kcal,1,\n208,protein,1,\n"))
	if err == nil {
		t.Fatal("expected an error for a duplicate source_code")
	}
}

func TestLoadMappingRejectsZeroFactor(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n208,energy_kcal,0,\n"))
	if err == nil {
		t.Fatal("expected an error for a zero factor")
	}
}

func TestUnitFor(t *testing.T) {
	m, _ := LoadMapping(strings.NewReader(goodCSV))
	u, ok := m.UnitFor("303")
	if !ok || string(u) != "mg" {
		t.Errorf("UnitFor(303) = %q, %v; want mg, true", u, ok)
	}
}
