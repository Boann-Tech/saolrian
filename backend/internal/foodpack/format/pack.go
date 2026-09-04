// Package format defines the on-disk food pack: a gob stream compressed
// with zstd.
//
// This is the ONLY foodpack package the server binary imports. Adapters
// and their heavyweight parsers live in sibling packages so they are never
// linked into the server.
package format

import (
	"encoding/gob"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/boanntech/saolrian/backend/internal/food"
)

// ErrVocabularyMismatch means the pack was built against a different
// canonical nutrient order, so its positional values cannot be trusted.
var ErrVocabularyMismatch = errors.New("pack was built with a different nutrient vocabulary")

// Portion is a household measure for a food.
type Portion struct {
	Label string
	Grams float64
}

// RefFood is one reference food, ready to seed into food_ref.
type RefFood struct {
	Source          string
	SourceID        string
	Region          string
	Licence         string
	Name            string
	NameLocale      string
	SearchText      string
	Nutrients       []float32 // positional, food.Encode order
	Portions        []Portion
	DefaultServingG float64
}

// SourceInfo records provenance and attribution for one dataset.
type SourceInfo struct {
	Source  string
	Region  string
	Licence string
	URL     string
	Rows    int
}

// Pack is a complete built pack.
type Pack struct {
	Version      string
	BuiltAt      time.Time
	NutrientKeys []string // vocabulary the positional values were encoded with
	Sources      []SourceInfo
	Foods        []RefFood
}

// Write encodes p as zstd-compressed gob.
func Write(w io.Writer, p Pack) error {
	zw, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
	if err != nil {
		return fmt.Errorf("zstd writer: %w", err)
	}
	if err := gob.NewEncoder(zw).Encode(p); err != nil {
		zw.Close()
		return fmt.Errorf("encode pack: %w", err)
	}
	return zw.Close()
}

// Read decodes a pack and verifies it was built with the current
// vocabulary.
func Read(r io.Reader) (Pack, error) {
	zr, err := zstd.NewReader(r)
	if err != nil {
		return Pack{}, fmt.Errorf("zstd reader: %w", err)
	}
	defer zr.Close()

	var p Pack
	if err := gob.NewDecoder(zr).Decode(&p); err != nil {
		return Pack{}, fmt.Errorf("decode pack: %w", err)
	}

	want := food.Keys()
	if len(p.NutrientKeys) != len(want) {
		return Pack{}, fmt.Errorf("%w: pack has %d keys, binary has %d",
			ErrVocabularyMismatch, len(p.NutrientKeys), len(want))
	}
	for i, k := range want {
		if p.NutrientKeys[i] != k {
			return Pack{}, fmt.Errorf("%w: slot %d is %q in pack, %q in binary",
				ErrVocabularyMismatch, i, p.NutrientKeys[i], k)
		}
	}
	return p, nil
}
