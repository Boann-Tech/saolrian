package food

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// latinFold covers the Latin letters that Unicode canonical decomposition
// cannot take apart, because their diacritic or ligature is baked into the
// code point rather than expressed as a combining mark. Without these,
// "smørrebrød" and "œufs" would keep characters a user typing on an
// English keyboard can never produce.
//
// Keys are lower case: SearchText lower-cases before folding.
var latinFold = map[rune]string{
	'ø': "o",
	'æ': "ae",
	'œ': "oe",
	'ß': "ss",
	'đ': "d",
	'ð': "d",
	'þ': "th",
	'ł': "l",
	'ı': "i",
	'ħ': "h",
	'ŋ': "n",
}

// SearchText normalises a food name for substring matching, per the design
// spec's `search_text` definition: lower-cased and accent-stripped, with
// punctuation collapsed to single spaces and surrounding whitespace
// trimmed. "Crème fraîche" becomes "creme fraiche".
//
// This lives in package food, not in the ingest adapters, for two reasons.
// The value is baked into the pack, so the pack and the server must agree
// on it exactly; and the search aggregator has to normalise the user's
// query with this same function while being forbidden from importing
// internal/foodpack/source.
//
// Letters outside Latin script are left as they are rather than dropped:
// stripping them would turn a name written in another script into an empty
// string, which no query could ever match.
func SearchText(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	prevSpace := true

	emit := func(r rune) {
		b.WriteRune(r)
		prevSpace = false
	}
	separate := func() {
		if !prevSpace {
			b.WriteByte(' ')
			prevSpace = true
		}
	}

	for _, r := range norm.NFD.String(strings.ToLower(name)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			// A combining accent left behind by decomposition. Dropping it
			// is the whole point, and it must not act as a separator.
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			emit(r)
		default:
			if folded, ok := latinFold[r]; ok {
				for _, fr := range folded {
					emit(fr)
				}
				continue
			}
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				emit(r)
				continue
			}
			separate()
		}
	}
	return strings.TrimSpace(b.String())
}
