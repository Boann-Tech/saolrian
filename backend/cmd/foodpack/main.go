// Command foodpack builds and verifies the bundled food reference pack.
//
// It is never linked into the server binary: the server imports only
// internal/foodpack/format.
//
//	foodpack build  --usda ./work/usda --version 2026.09 --out ./pack.bin.zst
//	foodpack verify --pack ./pack.bin.zst
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: foodpack <build|verify> [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "build":
		err = buildCmd(os.Args[2:])
	case "verify":
		err = verifyCmd(os.Args[2:])
	default:
		err = fmt.Errorf("unknown subcommand %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "foodpack:", err)
		os.Exit(1)
	}
}

func buildCmd(args []string) error {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	usdaDir := fs.String("usda", "", "directory of extracted USDA FDC CSVs")
	version := fs.String("version", "", "pack version, e.g. 2026.09")
	out := fs.String("out", "", "output pack path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *version == "" || *out == "" {
		return fmt.Errorf("--version and --out are required")
	}

	pack := format.Pack{
		Version:      *version,
		BuiltAt:      time.Now().UTC(),
		NutrientKeys: food.Keys(),
	}

	if *usdaDir != "" {
		m, err := source.LoadNamedMapping("usda")
		if err != nil {
			return err
		}
		foods, err := source.LoadUSDA(source.USDAOptions{
			Dir:       *usdaDir,
			DataTypes: []string{"foundation_food", "sr_legacy_food"},
			Mapping:   m,
		})
		if err != nil {
			return fmt.Errorf("usda: %w", err)
		}
		pack.Foods = append(pack.Foods, foods...)
		pack.Sources = append(pack.Sources, format.SourceInfo{
			Source: "usda", Region: "us", Licence: "public-domain",
			URL: "https://fdc.nal.usda.gov/", Rows: len(foods),
		})
		fmt.Printf("usda: %d foods\n", len(foods))
	}

	if len(pack.Foods) == 0 {
		return fmt.Errorf("no sources produced any foods; pass at least one source directory")
	}

	size, err := writePackAtomically(*out, pack)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d foods, %.1f MB\n", *out, len(pack.Foods), float64(size)/(1<<20))
	return nil
}

// writePackAtomically writes pack to a temp file in the same directory as
// out, then renames it into place only once the write has fully succeeded.
// This keeps a pre-existing file at out untouched (and no truncated file
// left behind at all) if the write fails partway — a real risk against a
// dataset the size of the full USDA download. It returns the size in bytes
// of the file left at out.
func writePackAtomically(out string, pack format.Pack) (int64, error) {
	dir := filepath.Dir(out)
	tmp, err := os.CreateTemp(dir, filepath.Base(out)+".tmp-*")
	if err != nil {
		return 0, err
	}
	tmpPath := tmp.Name()
	// Clean up the temp file on any path that returns before the rename
	// succeeds; once renamed, tmpPath no longer exists so this is a no-op.
	defer os.Remove(tmpPath)

	if err := format.Write(tmp, pack); err != nil {
		tmp.Close()
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}

	if err := os.Rename(tmpPath, out); err != nil {
		return 0, err
	}

	st, err := os.Stat(out)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func verifyCmd(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	packPath := fs.String("pack", "", "pack file to verify")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *packPath == "" {
		return fmt.Errorf("--pack is required")
	}

	f, err := os.Open(*packPath)
	if err != nil {
		return err
	}
	defer f.Close()

	pack, err := format.Read(f)
	if err != nil {
		return err
	}

	failed := false
	for _, r := range runChecks(pack) {
		status := "PASS"
		if !r.Pass {
			status, failed = "FAIL", true
		}
		fmt.Printf("%-16s %s  %s\n", r.Name, status, r.Detail)
	}
	if failed {
		return fmt.Errorf("verification failed")
	}
	fmt.Printf("\n%s: %d foods from %d sources, all checks passed\n",
		pack.Version, len(pack.Foods), len(pack.Sources))
	return nil
}
