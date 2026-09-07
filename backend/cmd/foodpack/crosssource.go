package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// crossSourceTolerance is how far one source's figure for an anchor food
// may sit from the median of the sources that carry it.
//
// Deliberately wide. Composition genuinely differs between countries —
// cultivar, soil, fortification policy, and each lab's own methods — and
// none of that is an error. What this check is looking for is an entire
// column read in the wrong unit: kilojoules as kilocalories is 318% out,
// milligrams as grams is 99,900% out. Both clear this band by an order of
// magnitude, while no real banana does.
const crossSourceTolerance = 0.25

// crossSourceKeys are the nutrients every source measures for every food,
// so a disagreement is about units rather than coverage.
var crossSourceKeys = []string{"energy_kcal", "protein", "fat", "carbohydrate"}

// crossSourceFloor is the value below which a relative comparison stops
// meaning anything: 0.1 g and 0.4 g of fat differ by 300% and both mean
// "no fat". Anchors include lean meat and leaf vegetables, so this is
// load-bearing.
//
// All four floors were raised when the non-USDA sources arrived, for two
// different reasons that are worth keeping apart.
//
// Energy and carbohydrate are the definitional pair. These sources do not
// merely measure the same quantity and get slightly different answers; they
// publish a *differently defined* quantity. USDA states
// carbohydrate by difference (fibre included), CoFID, CIQUAL and AFCD state
// available carbohydrate (fibre excluded); CoFID assigns carbohydrate 3.75
// kcal/g and fibre none, EU 1169/2011 assigns 4 and 2. On a banana those
// definitions differ by a few percent. On raw spinach -- 2 g of
// carbohydrate carrying 2 g of fibre -- they differ by 74%, which no
// tolerance can separate from an error.
//
// Protein and fat are not that. Both are the same quantity in all six
// sources; their spread is cultivar, Kjeldahl factor and butchery trim --
// sampling variance, not definition. Those two floors are ordinary
// tolerance widenings and should be read as such rather than as part of the
// argument above.
//
// What raising a floor costs: this check is looking for a whole column read
// in the wrong unit, and a whole column is wrong for every anchor food, so
// banana and milk still carry the comparison. But the floor is tested
// against the *median* (see evalCrossSource), not against each value, and a
// single-source outlier cannot move a five-source median -- so the food the
// check exists to find is precisely the one a floor can skip. What saves
// this today is that food.Nutrient's plausible maxima catch a
// milligram-for-gram slip on protein or fat long before this check would.
// A better instrument would keep the floors low and require both a relative
// deviation and an absolute gap in grams; that preserves every comparison
// and is not sensitive to the median at all. Left as a note rather than
// done here, because it changes what the check means.
//
// Raising the floors also cost real comparisons: a six-source pack offers
// 13 and this configuration makes 7. Two of the six dropped were passing
// cleanly (milk carbohydrate, spinach protein) and are collateral from
// floors set by other anchors.
var crossSourceFloor = map[string]float64{
	// 50, not 20: below it the energy conventions above diverge by more
	// than the 25% tolerance. Raw spinach is 23 kcal to USDA, 25 to CoFID
	// and 33 to CIQUAL, purely from what each counts.
	"energy_kcal": 50,
	// 3, for the same reason as fat below. A banana carries about 1.1 g of
	// protein and the five sources put it at 1.06, 1.09, 1.09, 1.2 and 1.4
	// -- a 0.3 g spread between cultivars and Kjeldahl factors that reads
	// as 28% against the median. Whole milk (3.4 g) and chicken breast
	// (24 g) stay in the comparison.
	"protein": 3,
	// 3, not 1: raw chicken breast is the anchor that sets this. USDA's
	// "meat only" trim publishes 2.62 g of fat, CIQUAL's "without skin"
	// 1.5, CoFID's light meat 1.1 and AFCD's "lean flesh" 0.8 -- a 3x
	// spread that is entirely how closely each country's butcher trims,
	// and no relative tolerance can tell that apart from an error. Nothing
	// is lost: below 3 g the sources already agree the food is lean, which
	// is itself proof that none of them read the column in the wrong unit,
	// and a genuine mg-for-g slip would put the median in the hundreds.
	"fat": 3,
	// 10, not 1: this is where by-difference and available carbohydrate
	// part company worst. Raw spinach runs 3.63 g (USDA, fibre included)
	// down to 0.6 g (AFCD, fibre excluded) -- a 6x spread on a food that
	// every source agrees has almost no carbohydrate. Above 10 g the fibre
	// a source does or does not count is a small share of the total again.
	"carbohydrate": 10,
}

// anchorEntry names one source's spelling of one anchor food.
type anchorEntry struct {
	Anchor    string
	Source    string
	NameRegex *regexp.Regexp
	Note      string
}

// loadAnchorTable reads the checked-in anchor table. It lives beside the
// golden table and is edited the same way: by a human, in a CSV, when a
// source renames a food.
func loadAnchorTable() ([]anchorEntry, error) {
	f, err := goldenFS.Open("golden/anchors.csv")
	if err != nil {
		return nil, fmt.Errorf("open anchor table: %w", err)
	}
	defer f.Close()
	return parseAnchorTable(f)
}

func parseAnchorTable(r io.Reader) ([]anchorEntry, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read anchor csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("anchor csv has no rows")
	}

	var out []anchorEntry
	seen := map[string]bool{}
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 3 {
			return nil, fmt.Errorf("line %d: want at least 3 columns, got %d", line, len(row))
		}
		e := anchorEntry{
			Anchor: strings.TrimSpace(row[0]),
			Source: strings.TrimSpace(row[1]),
		}
		if e.Anchor == "" || e.Source == "" {
			return nil, fmt.Errorf("line %d: anchor and source are both required", line)
		}
		key := e.Anchor + "\x00" + e.Source
		if seen[key] {
			return nil, fmt.Errorf("line %d: %s already has a regex for %s", line, e.Anchor, e.Source)
		}
		seen[key] = true
		pattern := strings.TrimSpace(row[2])
		if pattern == "" {
			// An empty pattern compiles to a wildcard matching every
			// food, which combined with lowest-SourceID selection would
			// anchor on an arbitrary food and report PASS. This is a
			// hand-edited CSV; a blank cell is the likeliest edit error,
			// not a deliberate "match anything".
			return nil, fmt.Errorf("line %d: empty name_regex", line)
		}
		e.NameRegex, err = regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad name_regex: %w", line, err)
		}
		if len(row) > 3 {
			e.Note = strings.TrimSpace(row[3])
		}
		out = append(out, e)
	}
	return out, nil
}

func checkCrossSource(p format.Pack) CheckResult {
	entries, err := loadAnchorTable()
	if err != nil {
		return CheckResult{"cross_source", false, fmt.Sprintf("load anchor table: %v", err)}
	}
	return evalCrossSource(p, entries)
}

// evalCrossSource compares each anchor food across every source that
// carries it.
//
// The comparison is against the median rather than the mean: with three or
// more sources, one wildly wrong value drags a mean far enough to put the
// correct sources outside the band and report the wrong culprit.
func evalCrossSource(p format.Pack, entries []anchorEntry) CheckResult {
	present := map[string]bool{}
	for _, s := range p.Sources {
		present[s.Source] = true
	}

	// Anchor order follows first appearance in the table so the report is
	// stable between runs.
	var anchors []string
	byAnchor := map[string][]anchorEntry{}
	for _, e := range entries {
		if _, seen := byAnchor[e.Anchor]; !seen {
			anchors = append(anchors, e.Anchor)
		}
		byAnchor[e.Anchor] = append(byAnchor[e.Anchor], e)
	}

	var failures []string
	compared := 0

	for _, anchor := range anchors {
		matches := map[string]food.Profile{}
		var sourcesInOrder []string
		for _, e := range byAnchor[anchor] {
			if !present[e.Source] {
				continue // this pack has no rows from that source at all
			}
			m := matchAnchor(p, e)
			if m == nil {
				failures = append(failures, fmt.Sprintf(
					"%s: source %s is present but no food name matched %q",
					anchor, e.Source, e.NameRegex.String()))
				continue
			}
			matches[e.Source] = food.Decode(m.Nutrients)
			sourcesInOrder = append(sourcesInOrder, e.Source)
		}
		if len(matches) < 2 {
			continue // nothing to compare
		}

		for _, key := range crossSourceKeys {
			var values []float64
			have := map[string]float64{}
			for _, s := range sourcesInOrder {
				v, ok := matches[s][key]
				if !ok {
					continue
				}
				have[s] = v
				values = append(values, v)
			}
			if len(values) < 2 {
				continue
			}
			med := median(values)
			if med < crossSourceFloor[key] {
				continue // relative agreement is meaningless down here
			}
			compared++
			for _, s := range sourcesInOrder {
				v, ok := have[s]
				if !ok {
					continue
				}
				if dev := math.Abs(v-med) / med; dev > crossSourceTolerance {
					failures = append(failures, fmt.Sprintf(
						"%s/%s: %s = %g but the median across %d sources is %g (%.0f%% out)",
						anchor, s, key, v, len(values), med, dev*100))
				}
			}
		}
	}

	switch {
	case len(failures) > 0:
		return CheckResult{"cross_source", false,
			fmt.Sprintf("%d disagreement(s): %s", len(failures), strings.Join(failures, "; "))}
	case compared == 0:
		// Pass-on-vacuous is deliberate: a single-source pack, or one
		// where no anchor food happens to be carried by two or more of
		// the sources present, is a legitimate development state, not a
		// failure. But the detail line must say that plainly rather than
		// implying two sources were compared and simply agreed -- with
		// %d source(s) present and 0 compared, "nothing to compare
		// across" alone reads as ambiguous about which of those it is.
		return CheckResult{"cross_source", true,
			fmt.Sprintf("%d source(s) in this pack, but no anchor food is carried by two or more of them; nothing was actually compared", len(p.Sources))}
	default:
		return CheckResult{"cross_source", true,
			fmt.Sprintf("%d nutrient comparisons agree within %.0f%%", compared, crossSourceTolerance*100)}
	}
}

// matchAnchor picks the food a regex names, resolving several matches by
// the lowest SourceID so the same pack always yields the same answer.
func matchAnchor(p format.Pack, e anchorEntry) *format.RefFood {
	var best *format.RefFood
	for i := range p.Foods {
		f := &p.Foods[i]
		if f.Source != e.Source || !e.NameRegex.MatchString(f.Name) {
			continue
		}
		if best == nil || f.SourceID < best.SourceID {
			best = f
		}
	}
	return best
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
