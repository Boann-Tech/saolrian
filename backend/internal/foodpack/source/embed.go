package source

import (
	"embed"
	"fmt"
)

// MappingFS holds the checked-in, human-auditable nutrient mapping tables
// and the archive manifest. These are the files to open when a number looks
// wrong or a dataset has moved.
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
