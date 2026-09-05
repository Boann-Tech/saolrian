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
// a repeated id, and collect range violations across the whole load instead
// of failing on the first.
type Builder struct {
	foods      []format.RefFood
	rows       map[string]int
	seen       map[string]bool
	violations []string
}

func NewBuilder() *Builder {
	return &Builder{rows: map[string]int{}, seen: map[string]bool{}}
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

	if err := food.Validate(in.Profile); err != nil {
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
		Nutrients:       food.Encode(in.Profile),
		Portions:        in.Portions,
		DefaultServingG: defaultServing,
	})
}

// Foods returns the assembled foods in Add order.
func (b *Builder) Foods() []format.RefFood { return b.foods }

// Rows counts accepted foods per source value, for SourceInfo.
func (b *Builder) Rows() map[string]int { return b.rows }

// Err returns the collected range violations as one error, prefixed with
// the adapter name, or nil when the load was clean.
func (b *Builder) Err(prefix string) error {
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
