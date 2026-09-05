package source

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCIQUAL is the ANSES CIQUAL table's source value in food_ref.
const SourceCIQUAL = "ciqual"

const (
	ciqualLicence = "licence-ouverte"
	ciqualRegion  = "fr"
	ciqualURL     = "https://ciqual.anses.fr/"
)

// ciqualValues is CIQUAL's cell grammar: French decimal commas, "traces"
// for a measured negligible amount, "-" for never measured, and "<" bounds
// on figures below the limit of quantification.
var ciqualValues = ValueSyntax{
	Absent:       []string{"-", "ND", "nd"},
	Trace:        []string{"traces", "trace"},
	DecimalComma: true,
}

// CIQUALOptions configures the CIQUAL adapter.
type CIQUALOptions struct {
	Dir      string // directory holding the extracted CIQUAL XML
	Mapping  *Mapping
	Unmapped UnmappedSink
}

type ciqualAlim struct {
	Code   string        `xml:"alim_code"`
	NomFR  string        `xml:"alim_nom_fr"`
	NomEng string        `xml:"alim_nom_eng"`
	Nested []ciqualCompo `xml:"COMPO"`
}

type ciqualCompo struct {
	AlimCode  string `xml:"alim_code"`
	ConstCode string `xml:"const_code"`
	Teneur    string `xml:"teneur"`
}

type ciqualConst struct {
	Code   string `xml:"const_code"`
	NomFR  string `xml:"const_nom_fr"`
	NomEng string `xml:"const_nom_eng"`
}

// ciqualDoc is everything the adapter needs, accumulated across however
// many XML files the release ships and in whatever order the elements
// appear.
type ciqualDoc struct {
	alims  map[string]ciqualAlim
	order  []string
	compos []ciqualCompo
	consts map[string]ciqualConst
}

// LoadCIQUAL reads the CIQUAL XML export.
func LoadCIQUAL(o CIQUALOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("ciqual: mapping is required")
	}

	doc, err := readCIQUALDir(o.Dir)
	if err != nil {
		return nil, nil, fmt.Errorf("ciqual: %w", err)
	}
	if len(doc.alims) == 0 {
		return nil, nil, fmt.Errorf("ciqual: %s contains no ALIM elements", o.Dir)
	}
	if err := ciqualCheckMapping(o.Mapping, doc.consts); err != nil {
		return nil, nil, err
	}

	profiles := map[string]food.Profile{}
	for _, c := range doc.compos {
		if _, ok := doc.alims[c.AlimCode]; !ok {
			continue
		}
		value, present, err := ciqualValues.Parse(c.Teneur)
		if err != nil {
			return nil, nil, fmt.Errorf("ciqual: food %s constituent %s: %w", c.AlimCode, c.ConstCode, err)
		}
		if !present {
			continue
		}
		key, out, ok := o.Mapping.Apply(c.ConstCode, value)
		if !ok {
			if !o.Mapping.Known(c.ConstCode) {
				noteUnmapped(o.Unmapped, c.ConstCode, ciqualLabel(doc.consts[c.ConstCode]))
			}
			continue
		}
		if profiles[c.AlimCode] == nil {
			profiles[c.AlimCode] = food.Profile{}
		}
		profiles[c.AlimCode][key] = out
	}

	b := NewBuilder()
	for _, code := range doc.order {
		a := doc.alims[code]
		name, locale, extra := ciqualNames(a)
		if name == "" {
			continue
		}
		b.Add(FoodInput{
			Source:      SourceCIQUAL,
			SourceID:    code,
			Region:      ciqualRegion,
			Licence:     ciqualLicence,
			Name:        name,
			NameLocale:  locale,
			SearchExtra: extra,
			Profile:     profiles[code],
			// CIQUAL publishes no household measures.
		})
	}
	if err := b.Err("ciqual"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()[SourceCIQUAL]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCIQUAL, Region: ciqualRegion, Licence: ciqualLicence,
		URL: ciqualURL, Rows: rows,
	}}, nil
}

// ciqualNames picks the displayed name and the searchable alternate.
// English is preferred because that is what the rest of the pack is in;
// the French name still has to find the food, so it goes to search only.
func ciqualNames(a ciqualAlim) (name, locale, extra string) {
	en := strings.TrimSpace(a.NomEng)
	fr := strings.TrimSpace(a.NomFR)
	if en != "" {
		return en, "", fr
	}
	return fr, "fr", ""
}

func ciqualLabel(c ciqualConst) string {
	if n := strings.TrimSpace(c.NomEng); n != "" {
		return n
	}
	return strings.TrimSpace(c.NomFR)
}

// readCIQUALDir streams every *.xml in dir. Releases have shipped both as
// one combined file with COMPO nested inside ALIM and as three sibling
// files, so the adapter takes elements wherever they turn up rather than
// betting on a layout that has already changed twice.
func readCIQUALDir(dir string) (*ciqualDoc, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.xml"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no .xml file in %s", dir)
	}
	sort.Strings(paths) // deterministic across filesystems

	doc := &ciqualDoc{alims: map[string]ciqualAlim{}, consts: map[string]ciqualConst{}}
	for _, p := range paths {
		if err := readCIQUALFile(p, doc); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
	}
	return doc, nil
}

func readCIQUALFile(path string, doc *ciqualDoc) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	dec := xml.NewDecoder(f)
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "ALIM":
			var a ciqualAlim
			if err := dec.DecodeElement(&a, &se); err != nil {
				return err
			}
			a.Code = strings.TrimSpace(a.Code)
			if a.Code == "" {
				continue
			}
			if _, seen := doc.alims[a.Code]; !seen {
				doc.alims[a.Code] = a
				doc.order = append(doc.order, a.Code)
			}
			// A release that nests COMPO inside ALIM has just had them
			// consumed by DecodeElement; collect them here.
			for _, c := range a.Nested {
				if strings.TrimSpace(c.AlimCode) == "" {
					c.AlimCode = a.Code
				}
				doc.compos = append(doc.compos, normaliseCompo(c))
			}
		case "COMPO":
			var c ciqualCompo
			if err := dec.DecodeElement(&c, &se); err != nil {
				return err
			}
			doc.compos = append(doc.compos, normaliseCompo(c))
		case "CONST":
			var c ciqualConst
			if err := dec.DecodeElement(&c, &se); err != nil {
				return err
			}
			c.Code = strings.TrimSpace(c.Code)
			if c.Code != "" {
				doc.consts[c.Code] = c
			}
		}
	}
}

func normaliseCompo(c ciqualCompo) ciqualCompo {
	c.AlimCode = strings.TrimSpace(c.AlimCode)
	c.ConstCode = strings.TrimSpace(c.ConstCode)
	return c
}

// ciqualCheckMapping fails a stale mapping, and a factor of 1 that
// disagrees with the unit CIQUAL states in the constituent's name.
func ciqualCheckMapping(m *Mapping, consts map[string]ciqualConst) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue
		}
		c, present := consts[code]
		if !present {
			return fmt.Errorf("ciqual: %w: const_code %s", ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			continue // a deliberate conversion; the factor is the assertion
		}
		srcUnit := unitFromLabel(ciqualLabel(c))
		if srcUnit == "" {
			continue // this release does not state a unit; nothing to check
		}
		if !unitMatches(unit, srcUnit) {
			return fmt.Errorf("ciqual const_code %s (%s): source unit %q but canonical unit is %q; check the factor in mapping/ciqual.csv",
				code, ciqualLabel(c), srcUnit, unit)
		}
	}
	return nil
}
