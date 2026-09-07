import { jsxs, jsx, Fragment } from "react/jsx-runtime";
import { renderToString } from "react-dom/server";
import { useState, useEffect, useRef } from "react";
const FEATURES = [
  {
    title: "Scan it and move on",
    body: "Point the camera at a barcode and the macros fill themselves in, from Open Food Facts’ 3M+ product database. No barcode? Search it, or type the calories and get on with your day.",
    icon: "barcode"
  },
  {
    title: "Name your own meals",
    body: "Breakfast, second breakfast, pre-workout, midnight raid. Add as many slots as you want and call them whatever you actually call them. Most trackers give you four and a shrug.",
    icon: "slots"
  },
  {
    title: "Log a recipe once, eat it all week",
    body: "Build a recipe from searched foods or straight macros, see the totals and the per-serving split, then log two servings as one diary entry. No re-adding six ingredients every Tuesday.",
    icon: "recipe"
  },
  {
    title: "Numbers you can check",
    body: "Mifflin-St Jeor or Katch-McArdle, five activity levels, lose/maintain/gain. The formula is named, the maths is open, and you can read the code that does it.",
    icon: "target"
  },
  {
    title: "One tap, no search",
    body: "Quick-add takes a calorie number and nothing else. Macros are optional. The fastest path from “I ate a thing” to “it’s logged” is not a search results page.",
    icon: "bolt"
  },
  {
    title: "Works on the plane",
    body: "Install it from the browser like an app. Entries queue locally when the network drops and sync themselves when you land — you never lose a log to a dead signal.",
    icon: "offline"
  },
  {
    title: "Make it look like yours",
    body: "Light, dark or system, eight accent palettes and a custom colour picker. Saved per user and per device, because your phone at 6am and your laptop at noon want different things.",
    icon: "palette"
  },
  {
    title: "Your data leaves whenever it likes",
    body: "Full CSV export, one click, no “contact support” form. Self-host and it is a single SQLite file you can copy to a USB stick. Leaving is a feature, not a punishment.",
    icon: "shield"
  }
];
const COMPARE_ROWS = [
  { label: "Free to use, in full", saolrian: true, loseit: "Premium upsell", mfp: "Premium upsell" },
  { label: "Ads in the app", saolrian: "Never", loseit: "Yes, free tier", mfp: "Yes, free tier" },
  { label: "Barcode scanning without paying", saolrian: true, loseit: false, mfp: false },
  { label: "Run it on your own server", saolrian: true, loseit: false, mfp: false },
  { label: "Source code you can read", saolrian: "MIT", loseit: false, mfp: false },
  { label: "Export everything, anytime", saolrian: "CSV, one click", loseit: "Zip export", mfp: "Premium only" },
  { label: "Unlimited custom meal slots", saolrian: true, loseit: false, mfp: false },
  { label: "Your data used for advertising", saolrian: "Never", loseit: "Per their policy", mfp: "Per their policy" }
];
const ROADMAP = [
  {
    tag: "Shipping now",
    title: "The tracker, owned",
    now: true,
    items: [
      "Food logging by search, barcode or quick-add",
      "Recipes with per-serving macros",
      "Unlimited custom meal slots",
      "TDEE and macro goals, weight and water history",
      "Lose It! food-log import (CSV)",
      "Self-host with one binary — no account with anyone required"
    ]
  },
  {
    tag: "Next",
    title: "The whole export, not one file",
    items: [
      "Upload your entire Lose It! export zip",
      "Pick from 24 categories: exercise, weight, sleep, steps, body fat, custom foods, recipes, goals",
      "Runs in the background, pushes you when it’s done",
      "Android Health Connect, Strava, Liftosaur",
      "A managed hosted tier, for people who would rather not run a server"
    ]
  },
  {
    tag: "Later",
    title: "Energy balance, end to end",
    items: [
      "Intake vs expenditure on one screen",
      "TDEE back-calculated from your own logged history",
      "Weekly review digests",
      "Family and coach sharing with per-field privacy"
    ]
  }
];
const FAQS = [
  {
    q: "Is Saolrian free?",
    a: "Yes. The app is MIT-licensed and self-hosting is free forever — there is no paid tier of the software, no feature held back behind a subscription, and no ads. A managed hosted tier is planned for people who would rather not run a server, and self-hosting will always be the full product."
  },
  {
    q: "Can I import my Lose It! data?",
    a: 'Today you can import your Lose It! food log as a CSV, which brings your day-by-day history across. The full import — upload the entire "Export Data" zip and pick from all 24 categories including exercise, weight, sleep, steps and custom foods — is designed and next on the roadmap.'
  },
  {
    q: "Do I need to run a server to use it?",
    a: "Self-hosting is one binary and one command, so it is far less work than it sounds. It is currently the way to run Saolrian: a managed hosted tier, for people who would rather not run anything at all, is on the roadmap. The app already asks which you want at first launch, so switching later changes nothing about how it works."
  },
  {
    q: "How is this different from MyFitnessPal or Lose It!?",
    a: "Three ways. Barcode scanning is free rather than paywalled. You can run the whole thing on hardware you own, so nobody can change the terms on your food diary. And the code is MIT-licensed, so you can read exactly what it does with your data instead of taking a privacy policy on faith."
  },
  {
    q: "Where is my data stored?",
    a: "In a single SQLite file on your own machine — back it up with Litestream, or just copy the file somewhere safe. When the hosted tier opens it will live on our servers instead, exportable to CSV at any time. Either way it is never sold, shared with advertisers, or used to train anything."
  },
  {
    q: "What food database does it use?",
    a: "Open Food Facts, a collaborative open database of over three million products with barcodes and full nutrition data. You can also save your own custom foods, and build recipes from either."
  },
  {
    q: "Does it work offline?",
    a: "Yes. It is an installable PWA, so it lives on your home screen like a native app. Diary entries you create without a connection are queued locally and replayed automatically once you are back online."
  },
  {
    q: 'What does "Saolrian" mean?',
    a: 'It is built from the Irish words saol, meaning life, and rian, meaning track. Life, tracked. It is pronounced roughly "SEEL-ree-un".'
  }
];
const SITE_URL = "https://saolrian.boanntech.com";
const GITHUB_REPO = "Boann-Tech/saolrian";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
const CONTACT_EMAIL = "hello@boanntech.com";
const FLAME = "M31 5c6.4 8.4 6.6 14.2 4.6 18.8 3.4-1.8 5.4-4.6 6-8.2C46.8 22.4 49 29 49 35.4 49 45.2 41 53 31.6 53 22.2 53 15 45.6 15 36.2c0-6.4 3-12.2 8.6-16.6-.5 5 .7 8.8 3.4 11.2C24.2 22.6 25.8 12.6 31 5Z";
const PULSE = "M10 39.5h14l3.2-8.4 4 13.6 3.2-9.4h6.8";
function LogoMark({ size = 28, className }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 64 64",
      className,
      fill: "none",
      "aria-hidden": "true",
      focusable: "false",
      children: [
        /* @__PURE__ */ jsxs("mask", { id: "saolrian-mark-pulse", children: [
          /* @__PURE__ */ jsx("rect", { width: "64", height: "64", fill: "#fff" }),
          /* @__PURE__ */ jsx(
            "path",
            {
              d: PULSE,
              fill: "none",
              stroke: "#000",
              strokeWidth: "4.6",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          )
        ] }),
        /* @__PURE__ */ jsx("path", { d: FLAME, fill: "currentColor", mask: "url(#saolrian-mark-pulse)" }),
        /* @__PURE__ */ jsx(
          "path",
          {
            d: FLAME,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2.2",
            strokeLinejoin: "round"
          }
        )
      ]
    }
  );
}
function Logo({
  size = 26,
  tone = "default"
}) {
  return /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-2.5", children: [
    /* @__PURE__ */ jsx(LogoMark, { size, className: tone === "invert" ? "text-good" : "text-accent" }),
    /* @__PURE__ */ jsx(
      "span",
      {
        className: [
          "text-xl font-bold tracking-[-0.03em]",
          tone === "invert" ? "text-white" : "text-text"
        ].join(" "),
        children: "Saolrian"
      }
    )
  ] });
}
const PATHS = {
  barcode: /* @__PURE__ */ jsx("path", { d: "M3 5v14M7 8v8M11 6v12M15 8v8M19 5v14" }),
  slots: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("rect", { x: "3", y: "4", width: "18", height: "16", rx: "3" }),
    /* @__PURE__ */ jsx("path", { d: "M8 9h8M8 13h5" })
  ] }),
  target: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "8.5" }),
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "4" }),
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "0.9", fill: "currentColor", stroke: "none" })
  ] }),
  import: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("path", { d: "M12 3v11M7.5 9.5 12 14l4.5-4.5" }),
    /* @__PURE__ */ jsx("path", { d: "M4 20h16" })
  ] }),
  chart: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("path", { d: "M3 17l4.5-7 4 5 4.5-8.5L20 12" }),
    /* @__PURE__ */ jsx("path", { d: "M3 21h18" })
  ] }),
  palette: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("path", { d: "M12 3a9 9 0 0 0 0 18h1.5a2.5 2.5 0 0 0 0-5H12a2 2 0 0 1 0-4h6a4 4 0 0 0-4-4z" }),
    /* @__PURE__ */ jsx("circle", { cx: "7.5", cy: "10.5", r: "0.9", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ jsx("circle", { cx: "10.5", cy: "7", r: "0.9", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ jsx("circle", { cx: "14.5", cy: "7", r: "0.9", fill: "currentColor", stroke: "none" })
  ] }),
  offline: /* @__PURE__ */ jsx("path", { d: "M5 12.55a11 11 0 0 1 14 0M8.5 16.1a6.5 6.5 0 0 1 7 0M12 20h.01" }),
  shield: /* @__PURE__ */ jsx("path", { d: "M9 12l2 2 4-4M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7z" }),
  recipe: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("path", { d: "M4 15h16a8 8 0 0 0-16 0zM3 19h18" }),
    /* @__PURE__ */ jsx("path", { d: "M12 7V4M9.5 5.5 12 4l2.5 1.5" })
  ] }),
  bolt: /* @__PURE__ */ jsx("path", { d: "M13 3 5 14h6l-1 7 8-11h-6z" })
};
function Icon({ name, size = 20 }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.9",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      children: PATHS[name]
    }
  );
}
function Check({ size = 17 }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx("path", { d: "m4 12.5 5 5L20 6.5" })
    }
  );
}
function Cross({ size = 15 }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.4",
      strokeLinecap: "round",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx("path", { d: "M6 6l12 12M18 6 6 18" })
    }
  );
}
function GitHubGlyph({ size = 17 }) {
  return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true", children: /* @__PURE__ */ jsx("path", { d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" }) });
}
function format(n) {
  return n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}
function GitHubStars({ className = "" }) {
  const [stars, setStars] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: "application/vnd.github+json" }
    }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((d) => {
      if (live && typeof d.stargazers_count === "number") setStars(d.stargazers_count);
    }).catch(() => {
    });
    return () => {
      live = false;
    };
  }, []);
  if (stars === null || stars < 1) return null;
  return /* @__PURE__ */ jsxs("span", { className: `tabular-nums ${className}`, children: [
    /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "★ " }),
    format(stars),
    /* @__PURE__ */ jsx("span", { className: "sr-only", children: " stars on GitHub" })
  ] });
}
function Container({ children, className = "" }) {
  return /* @__PURE__ */ jsx("div", { className: `mx-auto w-full max-w-[1140px] px-6 sm:px-8 ${className}`, children });
}
const VARIANTS = {
  primary: "bg-accent text-white border border-transparent hover:brightness-110",
  ghost: "bg-transparent text-text border border-border hover:border-accent hover:text-accent-ink",
  invert: "bg-white text-ink border border-transparent hover:brightness-95"
};
function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  external = false,
  className = ""
}) {
  return /* @__PURE__ */ jsx(
    "a",
    {
      href,
      ...external ? { target: "_blank", rel: "noreferrer noopener" } : {},
      className: [
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold no-underline",
        "transition-[filter,border-color,color,transform] duration-150 active:translate-y-px",
        size === "lg" ? "px-6 py-3.5 text-md" : "px-4.5 py-2.5 text-base",
        VARIANTS[variant],
        className
      ].join(" "),
      children
    }
  );
}
function SectionHead({
  kicker,
  title,
  lede,
  center = false
}) {
  return /* @__PURE__ */ jsxs("div", { className: center ? "mx-auto max-w-[680px] text-center" : "max-w-[680px]", children: [
    /* @__PURE__ */ jsx("p", { className: "kicker m-0", children: kicker }),
    /* @__PURE__ */ jsx("h2", { className: "mt-3 text-3xl font-bold sm:text-4xl", children: title }),
    lede && /* @__PURE__ */ jsx("p", { className: "mt-4 text-md leading-relaxed text-text-muted sm:text-lg", children: lede })
  ] });
}
function Chip({ tone = "accent", children }) {
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: [
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-bold uppercase tracking-[0.09em]",
        tone === "planned" ? "bg-surface text-text-faint ring-1 ring-border" : "bg-accent-soft text-accent-ink"
      ].join(" "),
      children
    }
  );
}
function useReveal() {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, className: `reveal${shown ? " shown" : ""}` };
}
function Reveal({ children, className = "" }) {
  const r = useReveal();
  return /* @__PURE__ */ jsx("div", { ref: r.ref, className: `${r.className} ${className}`, children });
}
const LINKS = [
  { href: "#switch", label: "Switching" },
  { href: "#compare", label: "Compare" },
  { href: "#features", label: "Features" },
  { href: "#selfhost", label: "Self-hosting" },
  { href: "#faq", label: "FAQ" }
];
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}
function ThemeToggle() {
  const [theme, setTheme] = useState("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("saolrian-site-theme");
      if (saved === "light" || saved === "dark") {
        setTheme(saved);
        applyTheme(saved);
      }
    } catch {
    }
  }, []);
  function cycle() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark" || !document.documentElement.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem("saolrian-site-theme", next);
    } catch {
    }
  }
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      onClick: cycle,
      "aria-label": "Switch between light and dark appearance",
      className: "flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:border-accent hover:text-accent-ink",
      children: /* @__PURE__ */ jsx("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.9", strokeLinecap: "round", children: theme === "dark" ? /* @__PURE__ */ jsx("path", { d: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "4.2" }),
        /* @__PURE__ */ jsx("path", { d: "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" })
      ] }) })
    }
  );
}
function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return /* @__PURE__ */ jsxs(
    "header",
    {
      className: [
        "sticky top-0 z-50 border-b bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] backdrop-blur-md transition-colors",
        scrolled ? "border-border" : "border-transparent"
      ].join(" "),
      children: [
        /* @__PURE__ */ jsxs(Container, { className: "flex h-16 items-center justify-between gap-4", children: [
          /* @__PURE__ */ jsx("a", { href: "#top", className: "no-underline", "aria-label": "Saolrian, home", children: /* @__PURE__ */ jsx(Logo, {}) }),
          /* @__PURE__ */ jsx("nav", { "aria-label": "Primary", className: "hidden items-center gap-7 lg:flex", children: LINKS.map((l) => /* @__PURE__ */ jsx(
            "a",
            {
              href: l.href,
              className: "text-base font-medium text-text-muted no-underline transition-colors hover:text-text",
              children: l.label
            },
            l.href
          )) }),
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
            /* @__PURE__ */ jsx(ThemeToggle, {}),
            /* @__PURE__ */ jsxs(
              "a",
              {
                href: GITHUB_URL,
                target: "_blank",
                rel: "noreferrer noopener",
                className: "hidden items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-base font-semibold text-white no-underline transition-[filter] hover:brightness-110 sm:inline-flex",
                children: [
                  /* @__PURE__ */ jsx(GitHubGlyph, {}),
                  "Star on GitHub",
                  /* @__PURE__ */ jsx(GitHubStars, { className: "text-white/75" })
                ]
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setOpen((o) => !o),
                "aria-expanded": open,
                "aria-controls": "mobile-nav",
                "aria-label": "Menu",
                className: "flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text lg:hidden",
                children: /* @__PURE__ */ jsx("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: open ? /* @__PURE__ */ jsx("path", { d: "M6 6l12 12M18 6 6 18" }) : /* @__PURE__ */ jsx("path", { d: "M4 7h16M4 12h16M4 17h16" }) })
              }
            )
          ] })
        ] }),
        open && /* @__PURE__ */ jsx("nav", { id: "mobile-nav", "aria-label": "Primary, mobile", className: "border-t border-border bg-bg lg:hidden", children: /* @__PURE__ */ jsxs(Container, { className: "flex flex-col py-2", children: [
          LINKS.map((l) => /* @__PURE__ */ jsx(
            "a",
            {
              href: l.href,
              onClick: () => setOpen(false),
              className: "border-b border-border py-3 text-md font-medium text-text no-underline last:border-0",
              children: l.label
            },
            l.href
          )),
          /* @__PURE__ */ jsxs(
            "a",
            {
              href: GITHUB_URL,
              target: "_blank",
              rel: "noreferrer noopener",
              className: "mt-3 mb-2 inline-flex items-center justify-center gap-2 rounded-lg bg-accent py-3 font-semibold text-white no-underline",
              children: [
                /* @__PURE__ */ jsx(GitHubGlyph, {}),
                "Star on GitHub"
              ]
            }
          )
        ] }) })
      ]
    }
  );
}
const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "#features", label: "Features" },
      { href: "#compare", label: "Compare" },
      { href: "#switch", label: "Import from Lose It!" },
      { href: "#roadmap", label: "Roadmap" }
    ]
  },
  {
    title: "Run it yourself",
    links: [
      { href: "#selfhost", label: "Quickstart" },
      { href: `${GITHUB_URL}#docker`, label: "Docker", ext: true },
      { href: `${GITHUB_URL}#development`, label: "Development", ext: true },
      { href: `${GITHUB_URL}#architecture`, label: "Architecture", ext: true }
    ]
  },
  {
    title: "Project",
    links: [
      { href: GITHUB_URL, label: "GitHub", ext: true },
      { href: `${GITHUB_URL}/issues`, label: "Issues", ext: true },
      { href: `${GITHUB_URL}/blob/main/LICENSE`, label: "MIT licence", ext: true },
      { href: "#faq", label: "FAQ" }
    ]
  }
];
function Footer() {
  return /* @__PURE__ */ jsx("footer", { className: "bg-ink py-14 text-ink-text", children: /* @__PURE__ */ jsxs(Container, { children: [
    /* @__PURE__ */ jsxs("div", { className: "grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx(Logo, { tone: "invert" }),
        /* @__PURE__ */ jsxs("p", { className: "mt-3 max-w-[300px] text-sm leading-relaxed", children: [
          "A calorie tracker you can actually own. Named for the Irish ",
          /* @__PURE__ */ jsx("i", { children: "saol" }),
          " (life) and",
          " ",
          /* @__PURE__ */ jsx("i", { children: "rian" }),
          " (track)."
        ] })
      ] }),
      COLUMNS.map((col) => /* @__PURE__ */ jsxs("nav", { "aria-label": col.title, children: [
        /* @__PURE__ */ jsx("p", { className: "m-0 text-xs font-bold uppercase tracking-[0.12em] text-white", children: col.title }),
        /* @__PURE__ */ jsx("ul", { className: "mt-3 space-y-2 p-0", children: col.links.map((l) => /* @__PURE__ */ jsx("li", { className: "list-none", children: /* @__PURE__ */ jsx(
          "a",
          {
            href: l.href,
            ..."ext" in l && l.ext ? { target: "_blank", rel: "noreferrer noopener" } : {},
            className: "text-sm text-ink-text no-underline transition-colors hover:text-good",
            children: l.label
          }
        ) }, l.label)) })
      ] }, col.title))
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-ink-line pt-6 text-sm", children: [
      /* @__PURE__ */ jsx("p", { className: "m-0", children: "© 2026 BoannTech · MIT licensed · Made in Ireland 🇮🇪" }),
      /* @__PURE__ */ jsxs("p", { className: "m-0", children: [
        "Food data from",
        " ",
        /* @__PURE__ */ jsx(
          "a",
          {
            href: "https://world.openfoodfacts.org",
            target: "_blank",
            rel: "noreferrer noopener",
            className: "text-good no-underline",
            children: "Open Food Facts"
          }
        ),
        ". Not affiliated with Lose It! or MyFitnessPal."
      ] })
    ] })
  ] }) });
}
const BUDGET = 2650;
const EATEN = 1470;
const PCT = Math.round(EATEN / BUDGET * 100);
const MACROS = [
  { key: "Protein", value: 96, target: 145 },
  { key: "Carbs", value: 210, target: 280 },
  { key: "Fat", value: 48, target: 78 }
];
const MEALS = [
  {
    name: "Breakfast",
    kcal: 420,
    items: [{ n: "Porridge with berries", d: "1 bowl · 07:42", k: 420 }]
  },
  {
    name: "Lunch",
    kcal: 620,
    items: [
      { n: "Chicken & orzo salad", d: "recipe · 1 serving", k: 495 },
      { n: "Greek yoghurt", d: "170 g · 13:10", k: 125 }
    ]
  },
  {
    name: "Pre-workout",
    kcal: 430,
    items: [{ n: "Banana & peanut butter", d: "scanned · 16:20", k: 430 }]
  }
];
function useCountUp(to, ms = 900) {
  const [n, setN] = useState(to);
  useEffect(() => {
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      setN(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    setN(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return n;
}
function AppMock() {
  const eaten = useCountUp(EATEN);
  const pct = Math.round(eaten / BUDGET * 100);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: "img",
      "aria-label": `The Saolrian Today screen: ${EATEN} of ${BUDGET} calories logged across breakfast, lunch and a pre-workout meal, with protein, carbohydrate and fat totals.`,
      className: "relative mx-auto w-[300px] select-none overflow-hidden rounded-[38px] border-[9px] border-ink bg-bg shadow-device",
      children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 pb-1 pt-2.5 text-2xs font-semibold text-text", children: [
          /* @__PURE__ */ jsx("span", { children: "9:41" }),
          /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-1 text-text-faint", "aria-hidden": "true", children: [
            /* @__PURE__ */ jsxs("svg", { width: "15", height: "10", viewBox: "0 0 15 10", fill: "currentColor", children: [
              /* @__PURE__ */ jsx("rect", { x: "0", y: "6", width: "2.4", height: "4", rx: "0.6" }),
              /* @__PURE__ */ jsx("rect", { x: "4", y: "4", width: "2.4", height: "6", rx: "0.6" }),
              /* @__PURE__ */ jsx("rect", { x: "8", y: "2", width: "2.4", height: "8", rx: "0.6" }),
              /* @__PURE__ */ jsx("rect", { x: "12", y: "0", width: "2.4", height: "10", rx: "0.6" })
            ] }),
            /* @__PURE__ */ jsxs("svg", { width: "17", height: "9", viewBox: "0 0 17 9", fill: "none", stroke: "currentColor", children: [
              /* @__PURE__ */ jsx("rect", { x: "0.5", y: "0.5", width: "13", height: "8", rx: "2" }),
              /* @__PURE__ */ jsx("rect", { x: "2", y: "2", width: "9", height: "5", rx: "1", fill: "currentColor", stroke: "none" }),
              /* @__PURE__ */ jsx("path", { d: "M15 3v3", strokeWidth: "1.6", strokeLinecap: "round" })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "border-b border-border bg-linear-[150deg,var(--color-accent-soft),var(--color-surface)_55%,var(--color-bg)] px-4 pb-4 pt-2", children: [
          /* @__PURE__ */ jsxs("p", { className: "m-0 flex items-center gap-1.5 text-[9px] font-bold tracking-[0.09em] text-text", children: [
            /* @__PURE__ */ jsx("span", { className: "inline-block h-2 w-2 rounded-[3px] bg-accent" }),
            "SAOLRIAN"
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "m-0 mt-1.5 text-lg font-bold", children: [
            "Good afternoon, ",
            /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "Sarah" })
          ] }),
          /* @__PURE__ */ jsx("p", { className: "m-0 text-2xs text-text-faint", children: "Thursday 3 September" }),
          /* @__PURE__ */ jsxs("div", { className: "mt-3 flex items-center justify-between rounded-xl border border-border bg-raised px-3.5 py-3 shadow-card", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("p", { className: "m-0 text-[9px] font-semibold uppercase tracking-[0.06em] text-text-faint", children: "Calories today" }),
              /* @__PURE__ */ jsxs("p", { className: "m-0 mt-0.5 text-2xl font-bold tabular-nums leading-none", children: [
                eaten.toLocaleString(),
                /* @__PURE__ */ jsxs("span", { className: "text-xs font-medium text-text-muted", children: [
                  " / ",
                  BUDGET.toLocaleString()
                ] })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "rounded-full bg-accent-soft px-2.5 py-1.5 text-center", children: [
              /* @__PURE__ */ jsxs("p", { className: "m-0 text-2xs font-bold text-accent-ink tabular-nums", children: [
                (BUDGET - EATEN).toLocaleString(),
                " left"
              ] }),
              /* @__PURE__ */ jsxs("p", { className: "m-0 text-[8px] text-text-faint", children: [
                PCT,
                "% of budget"
              ] })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "px-4 pt-3", children: [
          /* @__PURE__ */ jsx("div", { className: "h-1.5 overflow-hidden rounded-full bg-accent-soft", children: /* @__PURE__ */ jsx(
            "div",
            {
              className: "h-full rounded-full bg-linear-to-r from-[color-mix(in_srgb,var(--accent)_55%,#fff)] to-accent transition-[width] duration-700 ease-out",
              style: { width: `${pct}%` }
            }
          ) }),
          /* @__PURE__ */ jsxs("div", { className: "mt-1.5 flex justify-between text-[9px] text-text-faint", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsxs("b", { className: "text-text", children: [
                PCT,
                "%"
              ] }),
              " used"
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              "budget ",
              BUDGET.toLocaleString(),
              " kcal"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "mt-3 grid grid-cols-3 gap-1.5 px-4", children: MACROS.map((m) => /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-border bg-surface px-2 py-1.5", children: [
          /* @__PURE__ */ jsx("p", { className: "m-0 text-[7.5px] font-semibold uppercase tracking-[0.05em] text-text-faint", children: m.key }),
          /* @__PURE__ */ jsxs("p", { className: "m-0 text-xs font-bold tabular-nums", children: [
            m.value,
            "g",
            /* @__PURE__ */ jsxs("span", { className: "text-[8px] font-medium text-text-faint", children: [
              " / ",
              m.target
            ] })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "mt-1.5 h-[3px] overflow-hidden rounded-full bg-border", children: /* @__PURE__ */ jsx(
            "div",
            {
              className: "h-full rounded-full bg-accent",
              style: { width: `${Math.min(100, m.value / m.target * 100)}%` }
            }
          ) })
        ] }, m.key)) }),
        /* @__PURE__ */ jsxs("div", { className: "mt-3.5 px-4 pb-3", children: [
          MEALS.map((meal) => /* @__PURE__ */ jsxs("div", { className: "mb-2", children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-baseline justify-between px-0.5 pb-1.5", children: [
              /* @__PURE__ */ jsx("span", { className: "text-[11px] font-bold", children: meal.name }),
              /* @__PURE__ */ jsxs("span", { className: "text-[10px] font-semibold tabular-nums text-text-muted", children: [
                meal.kcal,
                " kcal"
              ] })
            ] }),
            meal.items.map((it) => /* @__PURE__ */ jsxs(
              "div",
              {
                className: "mb-1 flex items-center gap-2 rounded-[10px] border border-border bg-raised px-2.5 py-1.5",
                children: [
                  /* @__PURE__ */ jsx("span", { className: "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-accent-soft text-accent-ink", children: /* @__PURE__ */ jsx("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", children: /* @__PURE__ */ jsx("path", { d: "M4 15h16a8 8 0 0 0-16 0zM3 19h18" }) }) }),
                  /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
                    /* @__PURE__ */ jsx("span", { className: "block truncate text-[11px] font-semibold", children: it.n }),
                    /* @__PURE__ */ jsx("span", { className: "block text-[9px] text-text-faint", children: it.d })
                  ] }),
                  /* @__PURE__ */ jsxs("span", { className: "text-[11px] font-bold tabular-nums", children: [
                    it.k,
                    /* @__PURE__ */ jsx("span", { className: "text-[8px] font-medium text-text-faint", children: " kcal" })
                  ] })
                ]
              },
              it.n
            ))
          ] }, meal.name)),
          /* @__PURE__ */ jsx("div", { className: "rounded-[10px] border border-dashed border-accent-line py-1.5 text-center text-[10px] font-semibold text-accent-ink", children: "+ Add meal slot" })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "flex items-center justify-around border-t border-border bg-raised px-2 pb-3 pt-2", children: [
          ["Today", "M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z", true],
          ["Add", "M12 7v10M7 12h10", false],
          ["History", "M6 18V10M12 18V6M18 18v-5", false],
          ["Profile", "M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20a7 7 0 0 1 14 0", false]
        ].map(([label, d, active]) => /* @__PURE__ */ jsxs(
          "span",
          {
            className: `flex flex-col items-center gap-0.5 ${active ? "text-accent-ink" : "text-text-faint"}`,
            children: [
              /* @__PURE__ */ jsx("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.9", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx("path", { d }) }),
              /* @__PURE__ */ jsx("span", { className: "text-[8.5px] font-semibold", children: label })
            ]
          },
          label
        )) })
      ]
    }
  );
}
const TRUST = [
  "MIT licensed",
  "No ads, ever",
  "Barcode scanning free",
  "One 15 MB binary",
  "Export in one click"
];
function Hero() {
  return /* @__PURE__ */ jsx("section", { id: "top", className: "hero-wash overflow-hidden pb-20 pt-14 sm:pb-24 sm:pt-20", children: /* @__PURE__ */ jsx(Container, { children: /* @__PURE__ */ jsxs("div", { className: "grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10", children: [
    /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("p", { className: "kicker m-0", children: "The open-source Lose It! alternative" }),
      /* @__PURE__ */ jsxs("h1", { className: "mt-4 text-4xl font-bold sm:text-5xl lg:text-6xl", children: [
        "Leaving Lose It!?",
        /* @__PURE__ */ jsx("br", {}),
        "Don’t leave your ",
        /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "history" }),
        " behind."
      ] }),
      /* @__PURE__ */ jsx("p", { className: "mt-6 max-w-[520px] text-lg leading-relaxed text-text-muted", children: "Saolrian is a calorie tracker with no ads, no subscription and no paywall around the barcode scanner. Import your Lose It! food log and pick up exactly where you left off — then run the whole thing on your own server, if you want to." }),
      /* @__PURE__ */ jsxs("div", { className: "mt-8 flex flex-wrap items-center gap-3", children: [
        /* @__PURE__ */ jsxs(
          "a",
          {
            href: GITHUB_URL,
            target: "_blank",
            rel: "noreferrer noopener",
            className: "inline-flex items-center gap-2.5 rounded-lg bg-accent px-6 py-3.5 text-md font-semibold text-white no-underline transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px",
            children: [
              /* @__PURE__ */ jsx(GitHubGlyph, { size: 18 }),
              "Star on GitHub",
              /* @__PURE__ */ jsx(GitHubStars, { className: "text-white/75" })
            ]
          }
        ),
        /* @__PURE__ */ jsx(ButtonLink, { href: "#switch", variant: "ghost", size: "lg", children: "How switching works" })
      ] }),
      /* @__PURE__ */ jsx("ul", { className: "mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 p-0 text-sm text-text-faint", children: TRUST.map((t) => /* @__PURE__ */ jsxs("li", { className: "flex list-none items-center gap-1.5", children: [
        /* @__PURE__ */ jsx("span", { "aria-hidden": "true", className: "inline-block h-1.5 w-1.5 rounded-full bg-good" }),
        t
      ] }, t)) })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "flex justify-center lg:justify-end", children: /* @__PURE__ */ jsx(AppMock, {}) })
  ] }) }) });
}
const STEPS$1 = [
  {
    no: "01",
    title: "Export from Lose It!",
    body: "Settings → Export Data. They email you a zip of everything you have ever logged. It is your data and they do hand it over."
  },
  {
    no: "02",
    title: "Upload your food log",
    body: "Drop food-logs.csv into Saolrian. Every day, every meal, every entry lands in your diary with its calories and macros intact."
  },
  {
    no: "03",
    title: "Carry on logging",
    body: "Your history is behind you and today’s budget is in front of you. No fresh start, no lost streak, no year-one-again feeling."
  }
];
function Switch() {
  return /* @__PURE__ */ jsx("section", { id: "switch", className: "border-y border-border bg-surface py-20 sm:py-24", children: /* @__PURE__ */ jsxs(Container, { children: [
    /* @__PURE__ */ jsx(
      SectionHead,
      {
        kicker: "Switching",
        title: /* @__PURE__ */ jsxs(Fragment, { children: [
          "Five years of logs shouldn’t die in an",
          " ",
          /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "export folder" }),
          "."
        ] }),
        lede: "The reason people stay on a tracker they have stopped enjoying is the sunk cost of everything they already logged. So the importer was the first thing built, not the last."
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "mt-12 grid gap-5 md:grid-cols-3", children: STEPS$1.map((s, i) => /* @__PURE__ */ jsx(Reveal, { className: i === 1 ? "md:mt-6" : i === 2 ? "md:mt-12" : "", children: /* @__PURE__ */ jsxs("div", { className: "h-full rounded-xl border border-border bg-raised p-6 shadow-card", children: [
      /* @__PURE__ */ jsx("p", { className: "serif m-0 text-lg text-accent-ink", children: s.no }),
      /* @__PURE__ */ jsx("h3", { className: "mt-2 text-xl font-bold", children: s.title }),
      /* @__PURE__ */ jsx("p", { className: "mt-2 text-base leading-relaxed text-text-muted", children: s.body })
    ] }) }, s.no)) }),
    /* @__PURE__ */ jsxs("div", { className: "mt-8 flex flex-col gap-3 rounded-xl border border-accent-line bg-accent-soft p-6 sm:flex-row sm:items-center sm:gap-6", children: [
      /* @__PURE__ */ jsx("span", { className: "self-start", children: /* @__PURE__ */ jsx(Chip, { tone: "planned", children: "Next up" }) }),
      /* @__PURE__ */ jsxs("p", { className: "m-0 text-base leading-relaxed text-text-muted", children: [
        /* @__PURE__ */ jsx("b", { className: "text-text", children: "The whole zip, not one file." }),
        " Today the importer takes your food log. Next it takes the entire Lose It! export — you upload the zip, it shows which of the 24 categories it found (exercise, weight, sleep, steps, body fat, custom foods, recipes, goals), you tick what you want, and it imports in the background."
      ] })
    ] })
  ] }) });
}
function Cell({ value, ours }) {
  if (value === true) {
    return /* @__PURE__ */ jsxs("span", { className: ours ? "text-accent-ink" : "text-text-muted", children: [
      /* @__PURE__ */ jsx(Check, {}),
      /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Yes" })
    ] });
  }
  if (value === false) {
    return /* @__PURE__ */ jsxs("span", { className: "text-text-faint", children: [
      /* @__PURE__ */ jsx(Cross, {}),
      /* @__PURE__ */ jsx("span", { className: "sr-only", children: "No" })
    ] });
  }
  return /* @__PURE__ */ jsx("span", { className: `text-sm font-semibold ${ours ? "text-accent-ink" : "text-text-muted"}`, children: value });
}
function Compare() {
  return /* @__PURE__ */ jsx("section", { id: "compare", className: "py-20 sm:py-24", children: /* @__PURE__ */ jsxs(Container, { children: [
    /* @__PURE__ */ jsx(
      SectionHead,
      {
        kicker: "Compare",
        title: /* @__PURE__ */ jsxs(Fragment, { children: [
          "What you get, and what it",
          " ",
          /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "costs you" }),
          "."
        ] }),
        lede: "Lose It! and MyFitnessPal are good software. They are also businesses that need your subscription and your attention. Here is the same list of questions asked of all three."
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "mt-10 overflow-x-auto rounded-2xl border border-border", children: /* @__PURE__ */ jsxs("table", { className: "w-full min-w-[620px] border-collapse bg-raised text-left", children: [
      /* @__PURE__ */ jsx("caption", { className: "sr-only", children: "Feature comparison of Saolrian, Lose It! and MyFitnessPal free tiers" }),
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-border", children: [
        /* @__PURE__ */ jsx("th", { scope: "col", className: "w-[38%] px-5 py-4 text-sm font-semibold text-text-faint", children: " " }),
        /* @__PURE__ */ jsx("th", { scope: "col", className: "bg-accent-soft px-5 py-4 text-center text-md font-bold text-accent-ink", children: "Saolrian" }),
        /* @__PURE__ */ jsx("th", { scope: "col", className: "px-5 py-4 text-center text-md font-semibold text-text-muted", children: "Lose It!" }),
        /* @__PURE__ */ jsx("th", { scope: "col", className: "px-5 py-4 text-center text-md font-semibold text-text-muted", children: "MyFitnessPal" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: COMPARE_ROWS.map((row) => /* @__PURE__ */ jsxs("tr", { className: "border-b border-border last:border-0", children: [
        /* @__PURE__ */ jsx("th", { scope: "row", className: "px-5 py-3.5 text-base font-medium text-text", children: row.label }),
        /* @__PURE__ */ jsx("td", { className: "bg-accent-soft px-5 py-3.5 text-center align-middle", children: /* @__PURE__ */ jsx("span", { className: "inline-flex justify-center", children: /* @__PURE__ */ jsx(Cell, { value: row.saolrian, ours: true }) }) }),
        /* @__PURE__ */ jsx("td", { className: "px-5 py-3.5 text-center align-middle", children: /* @__PURE__ */ jsx("span", { className: "inline-flex justify-center", children: /* @__PURE__ */ jsx(Cell, { value: row.loseit, ours: false }) }) }),
        /* @__PURE__ */ jsx("td", { className: "px-5 py-3.5 text-center align-middle", children: /* @__PURE__ */ jsx("span", { className: "inline-flex justify-center", children: /* @__PURE__ */ jsx(Cell, { value: row.mfp, ours: false }) }) })
      ] }, row.label)) })
    ] }) }),
    /* @__PURE__ */ jsxs("p", { className: "mt-4 text-sm text-text-faint", children: [
      "Competitor rows describe each app’s free tier as of September 2026 and are drawn from their published pricing and privacy policies. Think one is wrong?",
      " ",
      /* @__PURE__ */ jsx(
        "a",
        {
          href: `${GITHUB_URL}/issues/new`,
          target: "_blank",
          rel: "noreferrer noopener",
          className: "font-medium text-accent-ink",
          children: "Open an issue and it gets fixed."
        }
      )
    ] })
  ] }) });
}
function Features() {
  return /* @__PURE__ */ jsx("section", { id: "features", className: "border-y border-border bg-surface py-20 sm:py-24", children: /* @__PURE__ */ jsxs(Container, { children: [
    /* @__PURE__ */ jsx(
      SectionHead,
      {
        kicker: "Features",
        title: /* @__PURE__ */ jsxs(Fragment, { children: [
          "Built for the logging you actually",
          " ",
          /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "do" }),
          "."
        ] }),
        lede: "Not a feature list written to fill a comparison chart. Every one of these exists because logging food three times a day gets tedious, and tedium is what makes people quit."
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4", children: FEATURES.map((f) => /* @__PURE__ */ jsx(Reveal, { className: "h-full", children: /* @__PURE__ */ jsxs("article", { className: "flex h-full flex-col rounded-xl border border-border bg-raised p-5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent-line hover:shadow-lift", children: [
      /* @__PURE__ */ jsx("span", { className: "flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-ink", children: /* @__PURE__ */ jsx(Icon, { name: f.icon }) }),
      /* @__PURE__ */ jsx("h3", { className: "mt-4 text-lg font-bold", children: f.title }),
      f.status === "planned" && /* @__PURE__ */ jsx("span", { className: "mt-2", children: /* @__PURE__ */ jsx(Chip, { tone: "planned", children: "Planned" }) }),
      /* @__PURE__ */ jsx("p", { className: "mt-2 text-sm leading-relaxed text-text-muted", children: f.body })
    ] }) }, f.title)) })
  ] }) });
}
function CopyCommand({ command, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2e3);
    return () => clearTimeout(t);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
    }
  }
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 rounded-lg border border-ink-line bg-ink-deep px-4 py-3", children: [
    /* @__PURE__ */ jsxs("code", { className: "min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-white", children: [
      /* @__PURE__ */ jsx("span", { className: "select-none text-ink-text", children: "$ " }),
      command
    ] }),
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: copy,
        className: "shrink-0 rounded-md border border-ink-line px-3 py-1.5 text-xs font-semibold text-ink-text transition-colors hover:border-good hover:text-good",
        children: copied ? "Copied" : label
      }
    ),
    /* @__PURE__ */ jsx("span", { "aria-live": "polite", className: "sr-only", children: copied ? "Command copied to clipboard" : "" })
  ] });
}
const STEPS = [
  {
    no: "01",
    title: "One binary, ~15 MB",
    body: "Database, auth, file storage and admin UI are all inside it. Linux, macOS, Windows, ARM — your NAS counts."
  },
  {
    no: "02",
    title: "One command",
    body: "Your data is one SQLite file. Back it up by copying it, or point Litestream at S3 and stop thinking about it."
  },
  {
    no: "03",
    title: "Point the app at it",
    body: "First launch asks: hosted or self-hosted? Enter your URL and sign in. Identical app, your hardware, your rules."
  }
];
function SelfHost() {
  return /* @__PURE__ */ jsx("section", { id: "selfhost", className: "py-20 sm:py-24", children: /* @__PURE__ */ jsx(Container, { children: /* @__PURE__ */ jsxs("div", { className: "relative overflow-hidden rounded-[28px] bg-ink p-8 sm:p-12", children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        "aria-hidden": "true",
        className: "pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(62,207,142,0.18),transparent_70%)]"
      }
    ),
    /* @__PURE__ */ jsxs("div", { className: "relative", children: [
      /* @__PURE__ */ jsx("p", { className: "kicker m-0 text-good", children: "Self-hosting is a first-class feature" }),
      /* @__PURE__ */ jsxs("h2", { className: "mt-3 max-w-[640px] text-3xl font-bold text-white sm:text-4xl", children: [
        "Your server. Your SQLite file. ",
        /* @__PURE__ */ jsx("span", { className: "serif text-good", children: "Nobody’s terms." })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "mt-4 max-w-[600px] text-md leading-relaxed text-ink-text", children: "Self-hosting usually means a weekend of Docker archaeology and a compose file you don’t understand. Saolrian is one Go binary built on PocketBase. If you can run a file, you can run Saolrian — and nobody can change the terms on your food diary afterwards." }),
      /* @__PURE__ */ jsx("div", { className: "mt-9 grid gap-4 md:grid-cols-3", children: STEPS.map((s) => /* @__PURE__ */ jsxs("div", { className: "rounded-xl border border-ink-line bg-white/5 p-5", children: [
        /* @__PURE__ */ jsx("p", { className: "serif m-0 text-base text-good", children: s.no }),
        /* @__PURE__ */ jsx("h3", { className: "mt-1.5 text-md font-bold text-white", children: s.title }),
        /* @__PURE__ */ jsx("p", { className: "mt-1.5 text-sm leading-relaxed text-ink-text", children: s.body })
      ] }, s.no)) }),
      /* @__PURE__ */ jsxs("div", { className: "mt-8 space-y-2.5", children: [
        /* @__PURE__ */ jsx(CopyCommand, { command: "docker compose up -d" }),
        /* @__PURE__ */ jsx(CopyCommand, { command: "./saolrian serve --http 0.0.0.0:8090" })
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "mt-3 text-sm text-ink-text", children: [
        "Brings up the app, the PocketBase admin at ",
        /* @__PURE__ */ jsx("code", { className: "font-mono", children: "/_/" }),
        ", and Caddy routing the API. Data persists in a named volume."
      ] })
    ] })
  ] }) }) });
}
function Roadmap() {
  return /* @__PURE__ */ jsx("section", { id: "roadmap", className: "border-y border-border bg-surface py-20 sm:py-24", children: /* @__PURE__ */ jsxs(Container, { children: [
    /* @__PURE__ */ jsx(
      SectionHead,
      {
        kicker: "Roadmap",
        title: /* @__PURE__ */ jsxs(Fragment, { children: [
          "Shipped, next, and",
          " ",
          /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "honestly labelled" }),
          "."
        ] }),
        lede: "Everything in the first column works today. Everything in the other two does not yet, and this page will not pretend otherwise."
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "mt-12 grid gap-5 md:grid-cols-3", children: ROADMAP.map((phase) => /* @__PURE__ */ jsx(Reveal, { className: "h-full", children: /* @__PURE__ */ jsxs(
      "div",
      {
        className: [
          "h-full rounded-2xl border p-6",
          phase.now ? "border-accent-line bg-linear-to-b from-accent-soft to-raised" : "border-border bg-raised"
        ].join(" "),
        children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              className: [
                "inline-block rounded-full px-3 py-1 text-2xs font-bold uppercase tracking-[0.09em]",
                phase.now ? "bg-accent text-white" : "bg-surface text-text-faint ring-1 ring-border"
              ].join(" "),
              children: phase.tag
            }
          ),
          /* @__PURE__ */ jsx("h3", { className: "mt-4 text-xl font-bold", children: phase.title }),
          /* @__PURE__ */ jsx("ul", { className: "mt-3 space-y-2 p-0", children: phase.items.map((item) => /* @__PURE__ */ jsxs(
            "li",
            {
              className: "relative list-none pl-5 text-base leading-relaxed text-text-muted",
              children: [
                /* @__PURE__ */ jsx(
                  "span",
                  {
                    "aria-hidden": "true",
                    className: [
                      "absolute left-0 top-2.5 h-1.5 w-1.5 rounded-full",
                      phase.now ? "bg-accent" : "bg-text-faint"
                    ].join(" ")
                  }
                ),
                item
              ]
            },
            item
          )) })
        ]
      }
    ) }, phase.tag)) })
  ] }) });
}
function Faq() {
  const [open, setOpen] = useState(0);
  return /* @__PURE__ */ jsx("section", { id: "faq", className: "py-20 sm:py-24", children: /* @__PURE__ */ jsx(Container, { children: /* @__PURE__ */ jsxs("div", { className: "grid gap-12 lg:grid-cols-[0.85fr_1.15fr]", children: [
    /* @__PURE__ */ jsx(
      SectionHead,
      {
        kicker: "Questions",
        title: /* @__PURE__ */ jsxs(Fragment, { children: [
          "The things people ask",
          " ",
          /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "before switching" }),
          "."
        ] }),
        lede: "Short answers, no asterisks."
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "divide-y divide-border border-y border-border", children: FAQS.map((f, i) => /* @__PURE__ */ jsxs(
      "details",
      {
        open: open === i,
        onToggle: (e) => {
          if (e.currentTarget.open) setOpen(i);
          else if (open === i) setOpen(null);
        },
        className: "group",
        children: [
          /* @__PURE__ */ jsxs("summary", { className: "flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-md font-semibold marker:content-none", children: [
            f.q,
            /* @__PURE__ */ jsx(
              "span",
              {
                "aria-hidden": "true",
                className: "shrink-0 text-accent-ink transition-transform duration-200 group-open:rotate-45",
                children: /* @__PURE__ */ jsx("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", children: /* @__PURE__ */ jsx("path", { d: "M12 6v12M6 12h12" }) })
              }
            )
          ] }),
          /* @__PURE__ */ jsx("p", { className: "m-0 max-w-[62ch] pb-5 text-base leading-relaxed text-text-muted", children: f.a })
        ]
      },
      f.q
    )) })
  ] }) }) });
}
function Waitlist() {
  const [state, setState] = useState("idle");
  const [email, setEmail] = useState("");
  {
    return /* @__PURE__ */ jsxs("p", { className: "m-0 text-base text-text-muted", children: [
      "Want a nudge when the hosted tier opens?",
      " ",
      /* @__PURE__ */ jsx(
        "a",
        {
          href: `mailto:${CONTACT_EMAIL}?subject=Saolrian%20beta`,
          className: "font-semibold text-accent-ink",
          children: "Email us"
        }
      ),
      " ",
      "and you’re on the list."
    ] });
  }
}
function Cta() {
  return /* @__PURE__ */ jsx("section", { className: "border-t border-border bg-linear-to-b from-accent-soft to-bg py-20 sm:py-24", children: /* @__PURE__ */ jsxs(Container, { className: "text-center", children: [
    /* @__PURE__ */ jsx("p", { className: "kicker m-0", children: "Get started" }),
    /* @__PURE__ */ jsxs("h2", { className: "mx-auto mt-3 max-w-[700px] text-3xl font-bold sm:text-4xl", children: [
      "It’s free, it’s MIT, and your data",
      " ",
      /* @__PURE__ */ jsx("span", { className: "serif text-accent-ink", children: "never leaves the room" }),
      "."
    ] }),
    /* @__PURE__ */ jsx("p", { className: "mx-auto mt-4 max-w-[560px] text-md leading-relaxed text-text-muted", children: "Star the repo to follow along, or clone it and have your own instance running before the kettle boils." }),
    /* @__PURE__ */ jsxs("div", { className: "mt-8 flex flex-wrap justify-center gap-3", children: [
      /* @__PURE__ */ jsxs(
        "a",
        {
          href: GITHUB_URL,
          target: "_blank",
          rel: "noreferrer noopener",
          className: "inline-flex items-center gap-2.5 rounded-lg bg-accent px-6 py-3.5 text-md font-semibold text-white no-underline transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px",
          children: [
            /* @__PURE__ */ jsx(GitHubGlyph, { size: 18 }),
            "Star on GitHub",
            /* @__PURE__ */ jsx(GitHubStars, { className: "text-white/75" })
          ]
        }
      ),
      /* @__PURE__ */ jsx(ButtonLink, { href: "#selfhost", variant: "ghost", size: "lg", children: "Read the quickstart" })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "mt-10 border-t border-border pt-8", children: /* @__PURE__ */ jsx(Waitlist, {}) })
  ] }) });
}
function structuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#app`,
        name: "Saolrian",
        applicationCategory: "HealthApplication",
        operatingSystem: "Web, Linux, macOS, Windows, Android, iOS",
        description: "Open-source calorie and macro tracker with free barcode scanning, Lose It! import, and single-binary self-hosting.",
        url: SITE_URL,
        codeRepository: GITHUB_URL,
        license: "https://opensource.org/licenses/MIT",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
        author: { "@type": "Organization", name: "BoannTech" }
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        mainEntity: FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a }
        }))
      }
    ]
  };
}
function App() {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "a",
      {
        href: "#main",
        className: "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-white",
        children: "Skip to content"
      }
    ),
    /* @__PURE__ */ jsx(Nav, {}),
    /* @__PURE__ */ jsxs("main", { id: "main", children: [
      /* @__PURE__ */ jsx(Hero, {}),
      /* @__PURE__ */ jsx(Switch, {}),
      /* @__PURE__ */ jsx(Compare, {}),
      /* @__PURE__ */ jsx(Features, {}),
      /* @__PURE__ */ jsx(SelfHost, {}),
      /* @__PURE__ */ jsx(Roadmap, {}),
      /* @__PURE__ */ jsx(Faq, {}),
      /* @__PURE__ */ jsx(Cta, {})
    ] }),
    /* @__PURE__ */ jsx(Footer, {}),
    /* @__PURE__ */ jsx(
      "script",
      {
        type: "application/ld+json",
        dangerouslySetInnerHTML: { __html: JSON.stringify(structuredData()) }
      }
    )
  ] });
}
function render() {
  return renderToString(/* @__PURE__ */ jsx(App, {}));
}
export {
  render
};
