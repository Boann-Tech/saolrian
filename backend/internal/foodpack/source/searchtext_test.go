package source

import "testing"

func TestSearchText(t *testing.T) {
	tests := map[string]string{
		"Bananas, raw":              "bananas raw",
		"Cheese,  cheddar (mature)": "cheese cheddar mature",
		"  Spinach, raw  ":          "spinach raw",
		"Crème fraîche":             "crème fraîche",
	}
	for in, want := range tests {
		if got := SearchText(in); got != want {
			t.Errorf("SearchText(%q) = %q, want %q", in, got, want)
		}
	}
}
