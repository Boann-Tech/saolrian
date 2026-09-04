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

	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := format.Write(f, pack); err != nil {
		return err
	}

	st, err := f.Stat()
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d foods, %.1f MB\n", *out, len(pack.Foods), float64(st.Size())/(1<<20))
	return nil
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
