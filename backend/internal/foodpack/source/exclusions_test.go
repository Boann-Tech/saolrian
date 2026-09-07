package source

import (
	"strings"
	"testing"
)

const goodExclusionsCSV = `source,source_id,reason
usda_sr,172294,copper published 1000x a plausible figure; confirmed against the FDC API
usda_sr,173174,"manganese published over 100x a daily reference intake, with a comma in this reason"
`

func TestParseExclusionsReason(t *testing.T) {
	e, err := ParseExclusions(strings.NewReader(goodExclusionsCSV))
	if err != nil {
		t.Fatalf("ParseExclusions: %v", err)
	}
	reason, ok := e.Reason("usda_sr", "172294")
	if !ok || !strings.Contains(reason, "copper") {
		t.Errorf("Reason(usda_sr, 172294) = %q, %v", reason, ok)
	}
	if _, ok := e.Reason("usda_sr", "999999"); ok {
		t.Error("an id not in the table must not be reported excluded")
	}
	if _, ok := e.Reason("cnf", "172294"); ok {
		t.Error("the same source_id under a different source must not match")
	}
}

func TestNilExclusionsExcludesNothing(t *testing.T) {
	var e *Exclusions
	if _, ok := e.Reason("usda_sr", "172294"); ok {
		t.Error("a nil *Exclusions must exclude nothing")
	}
}

func TestParseExclusionsRequiresReason(t *testing.T) {
	_, err := ParseExclusions(strings.NewReader("source,source_id,reason\nusda_sr,1,\n"))
	if err == nil || !strings.Contains(err.Error(), "reason") {
		t.Fatalf("err = %v, want a complaint about the missing reason", err)
	}
}

func TestParseExclusionsRejectsDuplicateRow(t *testing.T) {
	csv := "source,source_id,reason\nusda_sr,1,first\nusda_sr,1,second\n"
	_, err := ParseExclusions(strings.NewReader(csv))
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("err = %v, want a complaint about the duplicate row", err)
	}
}

func TestParseExclusionsRejectsEmptySourceOrID(t *testing.T) {
	if _, err := ParseExclusions(strings.NewReader("source,source_id,reason\n,1,why\n")); err == nil {
		t.Error("an empty source must be rejected")
	}
	if _, err := ParseExclusions(strings.NewReader("source,source_id,reason\nusda_sr,,why\n")); err == nil {
		t.Error("an empty source_id must be rejected")
	}
}

// LoadExclusions must succeed against the checked-in exclusions.csv: every
// commit ships a table that at least parses.
func TestLoadExclusionsParsesTheCheckedInTable(t *testing.T) {
	e, err := LoadExclusions()
	if err != nil {
		t.Fatalf("LoadExclusions: %v", err)
	}
	if reason, ok := e.Reason("usda_sr", "172294"); !ok || reason == "" {
		t.Error("the checked-in table is expected to carry the copper toddler-powder exclusion")
	}
}
