package food

import "testing"

func TestSearchText(t *testing.T) {
	tests := map[string]string{
		"Bananas, raw":              "bananas raw",
		"Cheese,  cheddar (mature)": "cheese cheddar mature",
		"  Spinach, raw  ":          "spinach raw",
		// The spec defines search_text as "lowercased, accent-stripped":
		// a user typing "creme fraiche" must match the accented name.
		"Crème fraîche":     "creme fraiche",
		"Jalapeño peppers":  "jalapeno peppers",
		"Müsli":             "musli",
		"Smørrebrød":        "smorrebrod",
		"Œufs, jaune, cru":  "oeufs jaune cru",
		"Fromage à pâte 45": "fromage a pate 45",
	}
	for in, want := range tests {
		if got := SearchText(in); got != want {
			t.Errorf("SearchText(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestSearchTextIsIdempotent matters because the aggregator normalises a
// user query that may already be normalised, while the pack stores the
// normalised form of a raw name. Both paths must land on the same string.
func TestSearchTextIsIdempotent(t *testing.T) {
	for _, in := range []string{"Crème fraîche", "Bananas, raw", "Smørrebrød"} {
		once := SearchText(in)
		if twice := SearchText(once); twice != once {
			t.Errorf("SearchText(SearchText(%q)) = %q, want %q", in, twice, once)
		}
	}
}

// TestSearchTextKeepsNonLatinLetters guards the fallback: dropping a script
// we have no transliteration for would leave an empty string that no query
// can match.
func TestSearchTextKeepsNonLatinLetters(t *testing.T) {
	if got := SearchText("Ελιά"); got == "" {
		t.Error("SearchText dropped a non-Latin name entirely")
	}
}
