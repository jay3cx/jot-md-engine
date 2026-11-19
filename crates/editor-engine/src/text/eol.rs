use editor_protocol::{ConcreteEolKind, NewlinePolicy, SourceLineEnding};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EolKind {
    Lf,
    Crlf,
    Cr,
    None,
}

impl From<ConcreteEolKind> for EolKind {
    fn from(value: ConcreteEolKind) -> Self {
        match value {
            ConcreteEolKind::Lf => Self::Lf,
            ConcreteEolKind::Crlf => Self::Crlf,
            ConcreteEolKind::Cr => Self::Cr,
        }
    }
}

impl From<EolKind> for SourceLineEnding {
    fn from(value: EolKind) -> Self {
        match value {
            EolKind::Lf => Self::Lf,
            EolKind::Crlf => Self::Crlf,
            EolKind::Cr => Self::Cr,
            EolKind::None => Self::None,
        }
    }
}

pub(super) fn resolve_new_eol(
    line_endings: &[EolKind],
    insertion_line: usize,
    policy: &NewlinePolicy,
) -> EolKind {
    match policy {
        NewlinePolicy::Configured { eol } => eol.clone().into(),
        NewlinePolicy::DocumentDominant { fallback } => {
            dominant_eol(line_endings).unwrap_or_else(|| fallback.clone().into())
        }
        NewlinePolicy::NearestLine { fallback } => line_endings
            .get(insertion_line)
            .copied()
            .filter(|kind| *kind != EolKind::None)
            .or_else(|| {
                insertion_line
                    .checked_sub(1)
                    .and_then(|index| line_endings.get(index).copied())
                    .filter(|kind| *kind != EolKind::None)
            })
            .unwrap_or_else(|| fallback.clone().into()),
    }
}

fn dominant_eol(line_endings: &[EolKind]) -> Option<EolKind> {
    let counts = [EolKind::Lf, EolKind::Crlf, EolKind::Cr].map(|candidate| {
        (
            candidate,
            line_endings
                .iter()
                .filter(|kind| **kind == candidate)
                .count(),
        )
    });
    let max = counts.iter().map(|(_, count)| *count).max()?;
    if max == 0 || counts.iter().filter(|(_, count)| *count == max).count() != 1 {
        return None;
    }
    counts
        .into_iter()
        .find_map(|(kind, count)| (count == max).then_some(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dominant_eol_requires_a_unique_winner() {
        assert_eq!(
            dominant_eol(&[EolKind::Lf, EolKind::Lf, EolKind::None]),
            Some(EolKind::Lf)
        );
        assert_eq!(
            dominant_eol(&[EolKind::Lf, EolKind::Crlf, EolKind::None]),
            None
        );
    }
}
