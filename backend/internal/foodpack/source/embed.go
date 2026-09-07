package source

import (
	"embed"
	"fmt"
)

// MappingFS holds the checked-in, human-auditable nutrient mapping tables,
// the archive manifest, and the per-food exclusion table (exclusions.csv).
// These are the files to open when a number looks wrong, a dataset has
// moved, or a food is missing and might have been deliberately dropped.
//
//go:embed all:mapping all:manifest exclusions.csv
var MappingFS embed.FS

// LoadNamedMapping loads the mapping table for one dataset, e.g. "usda".
func LoadNamedMapping(name string) (*Mapping, error) {
	f, err := MappingFS.Open("mapping/" + name + ".csv")
	if err != nil {
		return nil, fmt.Errorf("open mapping %q: %w", name, err)
	}
	defer f.Close()
	return LoadMapping(f)
}
