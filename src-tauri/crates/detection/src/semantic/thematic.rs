//! Sermon topic detection — surfaces related verses when the preacher discusses
//! themes (humility, giving, etc.) without quoting chapter and verse.

/// Minimum vector similarity for a thematic (topic) hit (lower than quote detection).
pub const THEMATIC_MIN_SIMILARITY: f64 = 0.40;

/// Cap confidence shown in UI for thematic hits (distinguish from direct quotes).
pub const THEMATIC_MAX_CONFIDENCE: f64 = 0.68;

struct ThemeDef {
    id: &'static str,
    keywords: &'static [&'static str],
    /// Text embedded with the sermon snippet to pull topic-relevant verses.
    anchor: &'static str,
}

const THEMES: &[ThemeDef] = &[
    ThemeDef {
        id: "humility",
        keywords: &[
            "humble", "humility", "meek", "meekness", "lowly", "pride", "proud",
            "arrogant", "vanity", "selfish", "self-centered",
        ],
        anchor: "humble humility meek lowly heart servant before God pride",
    },
    ThemeDef {
        id: "giving",
        keywords: &[
            "give", "giving", "gave", "given", "generous", "generosity", "tithe",
            "tithes", "offering", "offerings", "alms", "charity", "donate",
            "donation", "cheerful giver", "sow", "sowing",
        ],
        anchor: "give generously offering tithe charity bless the poor cheerful giver",
    },
    ThemeDef {
        id: "faith",
        keywords: &["faith", "believe", "believing", "trust", "trusting", "doubt"],
        anchor: "faith trust believe God without seeing",
    },
    ThemeDef {
        id: "love",
        keywords: &["love", "loving", "compassion", "kindness", "mercy"],
        anchor: "love one another compassion mercy kindness",
    },
    ThemeDef {
        id: "prayer",
        keywords: &["pray", "prayer", "praying", "intercede", "petition"],
        anchor: "pray prayer seek the Lord intercession",
    },
    ThemeDef {
        id: "forgiveness",
        keywords: &["forgive", "forgiveness", "forgiving", "pardon", "grudge"],
        anchor: "forgive one another mercy pardon as Christ forgave",
    },
    ThemeDef {
        id: "salvation",
        keywords: &["saved", "salvation", "redeem", "redeemed", "born again", "gospel"],
        anchor: "salvation saved by grace faith gospel eternal life",
    },
    ThemeDef {
        id: "worship",
        keywords: &["worship", "praise", "glorify", "adore", "magnify"],
        anchor: "worship praise glorify the Lord in spirit and truth",
    },
];

fn word_matches_keyword(word: &str, keyword: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase();
    if w.is_empty() {
        return false;
    }
    if keyword.contains(' ') {
        return w.contains(keyword);
    }
    w == keyword || w.starts_with(keyword) || keyword.starts_with(&w)
}

/// Returns active theme ids mentioned in `text`.
pub fn active_themes(text: &str) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();

    let mut found = Vec::new();
    for theme in THEMES {
        let hit = theme.keywords.iter().any(|kw| {
            if kw.contains(' ') {
                lower.contains(kw)
            } else {
                words
                    .iter()
                    .any(|w| word_matches_keyword(w, kw))
            }
        });
        if hit {
            found.push(theme.id);
        }
    }
    found
}

/// Build embedding queries for vector search (anchor + sermon context).
pub fn thematic_queries(text: &str, theme_ids: &[&str]) -> Vec<String> {
    let mut queries = Vec::new();
    for id in theme_ids {
        if let Some(theme) = THEMES.iter().find(|t| t.id == *id) {
            queries.push(format!("{} {}", theme.anchor, text));
        }
    }
    queries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_humility_theme() {
        let t = active_themes("we must walk in humility before the Lord");
        assert!(t.contains(&"humility"));
    }

    #[test]
    fn detects_giving_theme() {
        let t = active_themes("God loves a cheerful giver and generous heart");
        assert!(t.contains(&"giving"));
    }

    #[test]
    fn no_theme_in_unrelated() {
        assert!(active_themes("turn to page forty two in the bulletin").is_empty());
    }
}
