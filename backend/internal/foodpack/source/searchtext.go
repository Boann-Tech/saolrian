package source

import "strings"

// SearchText normalises a food name for substring matching: lowercased,
// punctuation collapsed to spaces, whitespace squeezed.
func SearchText(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	prevSpace := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevSpace = false
		case r > 127:
			// Keep non-ASCII letters (é, ü) so locale names stay searchable.
			b.WriteRune(r)
			prevSpace = false
		default:
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}
