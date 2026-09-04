package source

import (
	"embed"
	"fmt"
)

// MappingFS holds the checked-in, human-auditable nutrient mapping tables.
// These are the files to open when a number looks wrong.
//
//go:embed all:mapping
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
