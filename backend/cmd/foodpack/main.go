// Command foodpack builds and verifies the bundled food reference pack.
//
// It is never linked into the server binary: the server imports only
// internal/foodpack/format.
//
//	foodpack fetch  --work ./work
//	foodpack build  --work ./work --version 2026.09 --out ./pack.bin.zst
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
		fmt.Fprintln(os.Stderr, "usage: foodpack <fetch|build|verify> [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "fetch":
		err = fetchCmd(os.Args[2:])
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

// sourceLoader runs one adapter over one extracted directory. The registry
// is keyed on the manifest's source column, so adding a dataset is a
// manifest row plus an entry here.
type sourceLoader func(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error)

var loaders = map[string]sourceLoader{
	// Both USDA subtypes come from LoadUSDA; each archive extracts to its
	// own directory and the data_type column inside decides the subtype.
	"usda_foundation": loadUSDADir,
	"usda_sr":         loadUSDADir,
	"cnf":             loadCNFDir,
	"ciqual":          loadCIQUALDir,
}

func loadUSDADir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("usda")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadUSDA(source.USDAOptions{
		Dir:       dir,
		DataTypes: []string{"foundation_food", "sr_legacy_food"},
		Mapping:   m,
		Unmapped:  sink,
	})
}

func loadCNFDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("cnf")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadCNF(source.CNFOptions{Dir: dir, Mapping: m, Unmapped: sink})
}

func loadCIQUALDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("ciqual")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadCIQUAL(source.CIQUALOptions{Dir: dir, Mapping: m, Unmapped: sink})
}

func buildCmd(args []string) error {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	work := fs.String("work", "", "work directory populated by `foodpack fetch`")
	usdaDir := fs.String("usda", "", "directory of extracted USDA FDC CSVs (overrides --work)")
	version := fs.String("version", "", "pack version, e.g. 2026.09")
	out := fs.String("out", "", "output pack path")
	reportUnmapped := fs.Bool("report-unmapped", false, "list every source nutrient code no mapping table covers")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *version == "" || *out == "" {
		return fmt.Errorf("--version and --out are required")
	}
	if *work == "" && *usdaDir == "" {
		return fmt.Errorf("pass --work, or at least one per-source directory flag")
	}

	var sink source.UnmappedSink
	collector := source.NewUnmappedCollector()
	if *reportUnmapped {
		sink = collector.Note
	}

	pack := format.Pack{
		Version:      *version,
		BuiltAt:      time.Now().UTC(),
		NutrientKeys: food.Keys(),
	}

	dirs, err := resolveSourceDirs(*work, map[string]string{"usda_sr": *usdaDir})
	if err != nil {
		return err
	}
	rows := map[string]*format.SourceInfo{}
	var order []string
	seen := map[string]string{} // source\x00id -> the dir that produced it

	for _, d := range dirs {
		foods, sources, err := loaders[d.source](d.dir, sink)
		if err != nil {
			return fmt.Errorf("%s: %w", d.source, err)
		}
		for _, f := range foods {
			key := f.Source + "\x00" + f.SourceID
			if prev, dup := seen[key]; dup {
				return fmt.Errorf("%s/%s appears in both %s and %s; the work directory has an archive extracted twice",
					f.Source, f.SourceID, prev, d.dir)
			}
			seen[key] = d.dir
		}
		pack.Foods = append(pack.Foods, foods...)
		for _, s := range sources {
			if got, ok := rows[s.Source]; ok {
				got.Rows += s.Rows
				continue
			}
			cp := s
			// Spec §3 wants the build to record per-source checksums
			// alongside counts and licences. The adapter cannot know which
			// archive it was handed, so the hash is stamped here from the
			// breadcrumb fetch left behind.
			cp.ArchiveSHA256 = d.sha256
			rows[s.Source] = &cp
			order = append(order, s.Source)
		}
	}
	for _, name := range order {
		pack.Sources = append(pack.Sources, *rows[name])
		fmt.Printf("%s: %d foods\n", name, rows[name].Rows)
	}

	if len(pack.Foods) == 0 {
		return fmt.Errorf("no sources produced any foods; pass at least one source directory")
	}

	if *reportUnmapped {
		fmt.Println()
		fmt.Println(collector.Report())
	}

	size, err := writePackAtomically(*out, pack)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d foods, %.1f MB\n", *out, len(pack.Foods), float64(size)/(1<<20))
	return nil
}

type sourceDir struct {
	source string
	dir    string
	sha256 string // the archive this directory was extracted from, if known
}

// resolveSourceDirs turns a work directory plus any explicit overrides into
// the list of (source, directory) pairs to load, in manifest order. A
// source whose directory is absent is skipped: building a US-only pack
// while the French download is still running has to stay possible.
func resolveSourceDirs(work string, overrides map[string]string) ([]sourceDir, error) {
	entries, err := source.LoadManifest()
	if err != nil {
		return nil, err
	}
	var out []sourceDir
	for _, e := range entries {
		loader, known := loaders[e.Source]
		if !known || loader == nil {
			continue // manifest row for an adapter this build does not have yet
		}
		dir := overrides[e.Source]
		var sha string
		if dir == "" && work != "" {
			candidate := filepath.Join(work, e.ExtractTo)
			if st, err := os.Stat(candidate); err == nil && st.IsDir() {
				dir = candidate
				// checkFetchRecord already reads the breadcrumb to validate
				// it against the manifest; reuse that read for sha instead
				// of reading the file a second time.
				sha, err = checkFetchRecord(candidate, e)
				if err != nil {
					return nil, err
				}
			}
		} else if dir != "" {
			rec, ok, err := source.ReadFetchRecord(dir)
			if err != nil {
				return nil, err
			}
			if ok {
				sha = rec.SHA256
			}
		}
		if dir == "" {
			continue
		}
		out = append(out, sourceDir{source: e.Source, dir: dir, sha256: sha})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no source directories found; run `foodpack fetch --work <dir>` first")
	}
	return out, nil
}

// checkFetchRecord reads the breadcrumb fetch left in dir and returns its
// recorded hash. It also catches a manifest re-pinned without a re-fetch:
// the directory then holds the old dataset while the manifest claims the
// new one, and nothing else would notice.
func checkFetchRecord(dir string, e source.ManifestEntry) (string, error) {
	rec, ok, err := source.ReadFetchRecord(dir)
	if err != nil {
		return "", err
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "warning: %s was not populated by `foodpack fetch`; its provenance is unrecorded\n", dir)
		return "", nil
	}
	if e.SHA256 != source.Unpinned && rec.SHA256 != e.SHA256 {
		return "", fmt.Errorf("%s holds the archive %s but the manifest now pins %s; re-run `foodpack fetch --source %s`",
			dir, rec.SHA256, e.SHA256, e.Source)
	}
	return rec.SHA256, nil
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
