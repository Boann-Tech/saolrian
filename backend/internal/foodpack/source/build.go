package source

import (
	"fmt"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// FoodInput is one source food handed to the shared assembly tail.
type FoodInput struct {
	Source   string
	SourceID string
	Region   string
	Licence  string
	Name     string
	// NameLocale is the language Name is written in, e.g. "fr". Empty
	// means English.
	NameLocale string
	// SearchExtra is folded into SearchText but never displayed: a
	// second-language name, or a synonym the source publishes separately.
	SearchExtra string
	Profile     food.Profile
	Portions    []format.Portion
}

// Builder assembles canonical foods from adapter output, applying the rules
// every adapter must share: skip foods with no data, keep the first row for
// a repeated id, drop a food the checked-in exclusion table names, and
// collect range violations across the whole load instead of failing on the
// first.
type Builder struct {
	foods        []format.RefFood
	rows         map[string]int
	seen         map[string]bool
	violations   []string
	exclusions   *Exclusions
	excludedRows map[string]int
	exclusionErr error // set if the checked-in exclusion table itself fails to load/parse
}

// NewBuilder returns a Builder loaded with the checked-in exclusion table
// (exclusions.csv). A malformed table surfaces through Err rather than
// panicking here, so a single bad row fails the build loudly instead of
// silently excluding nothing.
func NewBuilder() *Builder {
	b := &Builder{rows: map[string]int{}, seen: map[string]bool{}, excludedRows: map[string]int{}}
	ex, err := LoadExclusions()
	if err != nil {
		b.exclusionErr = err
		return b
	}
	b.exclusions = ex
	return b
}

// SetExclusions overrides the exclusion table Add consults, replacing the
// checked-in exclusions.csv. Tests use this to exercise the drop-without-
// failing behaviour against a table they control rather than depending on
// exclusions.csv's real, changing content.
func (b *Builder) SetExclusions(ex *Exclusions) {
	b.exclusions = ex
	b.exclusionErr = nil
}

// Add assembles one food. Call order fixes output order, so adapters should
// iterate their source file in file order to keep builds reproducible.
func (b *Builder) Add(in FoodInput) {
	if len(in.Profile) == 0 {
		return // no nutrient data at all: not worth shipping
	}
	key := in.Source + "\x00" + in.SourceID
	if b.seen[key] {
		// A repeated (source, source_id) would emit two rows against the
		// unique index the seed migration relies on. First row wins.
		return
	}

	// Claimed before validation, not after: a food that fails the range
	// check has still used up its id, and letting a later duplicate take
	// the slot would make the pack depend on which copy came first.
	b.seen[key] = true

	if _, excluded := b.exclusions.Reason(in.Source, in.SourceID); excluded {
		// Confirmed against the source's own published documentation to be
		// the source's own error (see exclusions.csv), not a mapping
		// defect: drop the food rather than counting it as a range
		// violation or raising a plausible maximum to admit it.
		b.excludedRows[in.Source]++
		return
	}

	profile := flushRoundingArtifacts(in.Profile)

	if err := food.Validate(profile); err != nil {
		b.violations = append(b.violations,
			fmt.Sprintf("%s/%s (%s): %v", in.Source, in.SourceID, in.Name, err))
		return
	}

	var defaultServing float64
	if len(in.Portions) > 0 {
		defaultServing = in.Portions[0].Grams
	}
	search := in.Name
	if in.SearchExtra != "" {
		search += " " + in.SearchExtra
	}
	b.rows[in.Source]++
	b.foods = append(b.foods, format.RefFood{
		Source:          in.Source,
		SourceID:        in.SourceID,
		Region:          in.Region,
		Licence:         in.Licence,
		Name:            in.Name,
		NameLocale:      in.NameLocale,
		SearchText:      food.SearchText(search),
		Nutrients:       food.Encode(profile),
		Portions:        in.Portions,
		DefaultServingG: defaultServing,
	})
}

// roundingArtifactFloor bounds how negative a value may be before
// flushRoundingArtifacts stops treating it as measurement noise and lets
// Validate reject it. No nutrient can truly carry negative mass, but a
// "by difference" figure — carbohydrate computed as 100 minus independently
// measured water, protein, fat and ash — inherits the rounding error of
// every component it subtracts. USDA's own FoodData Central publishes such
// values verbatim rather than flooring them: Foundation Foods fdc_id
// 2727566 ("Chicken, drumstick, meat and skin, raw") carries a published
// carbohydrate-by-difference of -0.47505 g/100g, confirmed against the
// FDC API itself, not a parsing or mapping defect. A handful of other raw
// meat/poultry items in the same release carry equally small negatives
// (as low as -0.705) for the same reason: real meat has ~0g carbohydrate,
// and the "by difference" arithmetic occasionally lands a hair under it.
//
// The floor is small and applies to any canonical key, not just
// carbohydrate, so it never masks the large deviations a wrong unit
// factor or a broken mapping produces — those still fail loudly.
const roundingArtifactFloor = -1.0

// flushRoundingArtifacts returns a copy of p with any negative-but-not-
// past-floor value replaced by 0.0 (rounding noise — see
// roundingArtifactFloor). p itself is never modified: it is the caller's
// input, and Add mutating a map out from under an adapter that still holds
// a reference to it would be a surprising action at a distance. Values at
// or past the floor are copied through unchanged so Validate still rejects
// them, and positive values are copied through untouched too.
func flushRoundingArtifacts(p food.Profile) food.Profile {
	out := make(food.Profile, len(p))
	for k, v := range p {
		if v < 0 && v > roundingArtifactFloor {
			v = 0
		}
		out[k] = v
	}
	return out
}

// Foods returns the assembled foods in Add order.
func (b *Builder) Foods() []format.RefFood { return b.foods }

// Rows counts accepted foods per source value, for SourceInfo.
func (b *Builder) Rows() map[string]int { return b.rows }

// Excluded counts, per source value, how many foods the exclusion table
// caused Add to drop.
func (b *Builder) Excluded() map[string]int { return b.excludedRows }

// ReportExcluded prints one line per source with excluded foods, sorted by
// source so output is stable across runs. A build that excluded nothing
// prints nothing. This exists so a food being dropped can never happen
// quietly: every exclusion shows up in the build's own output, alongside
// the reason recorded in exclusions.csv.
func (b *Builder) ReportExcluded() {
	if len(b.excludedRows) == 0 {
		return
	}
	sources := make([]string, 0, len(b.excludedRows))
	for s := range b.excludedRows {
		sources = append(sources, s)
	}
	sort.Strings(sources)
	for _, s := range sources {
		fmt.Printf("%s: excluded %d food(s) implausible in the source; see internal/foodpack/source/exclusions.csv\n",
			s, b.excludedRows[s])
	}
}

// Err returns the collected range violations as one error, prefixed with
// the adapter name, or nil when the load was clean. A checked-in exclusion
// table that failed to load or parse is reported here too, ahead of range
// violations: nothing downstream can trust which foods were meant to be
// excluded until that is fixed.
func (b *Builder) Err(prefix string) error {
	if b.exclusionErr != nil {
		return fmt.Errorf("%s: exclusions.csv: %w", prefix, b.exclusionErr)
	}
	if err := food.RangeViolationsError(b.violations); err != nil {
		return fmt.Errorf("%s: %w", prefix, err)
	}
	return nil
}

// UnmappedSink is called once per distinct source nutrient code that
// appears in a dataset but is absent from its mapping table. Adapters skip
// such codes silently by design — a national dataset carries hundreds of
// nutrients outside the canonical vocabulary — but whoever is writing a
// mapping table needs the authoritative list of what they have not covered.
type UnmappedSink func(code, label string)

func noteUnmapped(sink UnmappedSink, code, label string) {
	if sink != nil {
		sink(code, label)
	}
}

// UnmappedCollector gathers codes for `foodpack build --report-unmapped`.
type UnmappedCollector struct {
	labels map[string]string
}

func NewUnmappedCollector() *UnmappedCollector {
	return &UnmappedCollector{labels: map[string]string{}}
}

// Note satisfies UnmappedSink as a method value: c.Note.
func (c *UnmappedCollector) Note(code, label string) {
	if _, seen := c.labels[code]; !seen {
		c.labels[code] = label
	}
}

// Report renders the codes sorted, one per line, ready to paste into a
// mapping table as a starting point.
func (c *UnmappedCollector) Report() string {
	if len(c.labels) == 0 {
		return "no unmapped nutrient codes"
	}
	codes := make([]string, 0, len(c.labels))
	for code := range c.labels {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	var sb strings.Builder
	fmt.Fprintf(&sb, "%d unmapped nutrient code(s):\n", len(codes))
	for _, code := range codes {
		fmt.Fprintf(&sb, "  %s,-,1,%s\n", code, c.labels[code])
	}
	return sb.String()
}
