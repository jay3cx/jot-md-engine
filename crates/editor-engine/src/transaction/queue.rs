use std::collections::VecDeque;

use editor_protocol::Revision;

use crate::syntax::{
    AnalysisProgress, ParseError, SyntaxAnalysisSession, SyntaxSnapshot, WorkBudget,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AnalysisId(pub u64);

struct AnalysisJob {
    id: AnalysisId,
    generation: u64,
    target_revision: Revision,
    priority_to: Option<u32>,
    session: SyntaxAnalysisSession,
}

#[derive(Default)]
pub struct AnalysisQueue {
    next_id: u64,
    jobs: VecDeque<AnalysisJob>,
}

impl AnalysisQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新的修订取代原有任务，已过期的分析结果不能再发布。
    pub fn enqueue_latest(
        &mut self,
        generation: u64,
        target_revision: Revision,
        session: SyntaxAnalysisSession,
        priority_to: Option<u32>,
    ) -> AnalysisId {
        self.jobs.clear();
        self.next_id = self.next_id.checked_add(1).expect("analysis id exhausted");
        let id = AnalysisId(self.next_id);
        self.jobs.push_back(AnalysisJob {
            id,
            generation,
            target_revision,
            priority_to,
            session,
        });
        id
    }

    pub fn clear(&mut self) {
        self.jobs.clear();
    }

    pub fn cancel(&mut self, analysis_id: AnalysisId) -> bool {
        let old_len = self.jobs.len();
        self.jobs.retain(|job| job.id != analysis_id);
        self.jobs.len() != old_len
    }

    /// 只改变下一次有界工作片的停止目标。已确认的 parser state 会保留，且不会
    /// 创建第二个并发任务。
    pub fn reprioritize(&mut self, analysis_id: AnalysisId, priority_to: u32) -> bool {
        let Some(job) = self.jobs.iter_mut().find(|job| job.id == analysis_id) else {
            return false;
        };
        job.priority_to = Some(priority_to);
        true
    }

    /// 将本轮确认的节点追加到文档持有的语法树中，保留已经发布的前缀和节点 ID。
    pub(crate) fn poll_into(
        &mut self,
        current_generation: u64,
        current_revision: Revision,
        budget: WorkBudget,
        prefix: &mut SyntaxSnapshot,
    ) -> Result<Option<(AnalysisId, Revision, AnalysisProgress)>, ParseError> {
        let Some(progress) = self.advance(current_generation, current_revision, budget)? else {
            return Ok(None);
        };
        let job = self.jobs.front().expect("advanced job must exist");
        job.session.extend_snapshot(prefix);
        let result = (job.id, job.target_revision, progress);
        if progress.complete {
            self.jobs.pop_front();
        }
        Ok(Some(result))
    }

    fn advance(
        &mut self,
        current_generation: u64,
        current_revision: Revision,
        budget: WorkBudget,
    ) -> Result<Option<AnalysisProgress>, ParseError> {
        // 文档重新打开或再次编辑后，旧任务即使完成也不能发布结果，因此先清理。
        while self.jobs.front().is_some_and(|job| {
            job.generation != current_generation || job.target_revision != current_revision
        }) {
            self.jobs.pop_front();
        }
        let Some(job) = self.jobs.front_mut() else {
            return Ok(None);
        };
        // 每次 poll 只消耗调用方提供的预算，避免一次分析阻塞整个编辑器。
        let priority_to = job.priority_to;
        let progress = match priority_to {
            Some(to) => job
                .session
                .poll_priority(editor_protocol::TextRange::new(0, to), budget)?,
            None => job.session.poll(budget)?,
        };
        if priority_to.is_some_and(|to| progress.confirmed_range.to >= to) {
            job.priority_to = None;
        }
        Ok(Some(progress))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::CompiledSyntaxProfile;

    fn session(source: &str) -> SyntaxAnalysisSession {
        SyntaxAnalysisSession::from_source(
            source,
            CompiledSyntaxProfile::compile(Default::default()),
        )
        .unwrap()
    }

    #[test]
    fn incremental_publication_matches_owned_snapshots_at_every_tick() {
        let source =
            "# heading **bold**\n\n- item\n| a | b |\n| --- | --- |\n| c | d |\n".repeat(300);
        let mut initial = session(&source);
        initial.poll(WorkBudget::new(3, 3)).unwrap();
        let mut prefix = initial.prefix_snapshot();
        let mut expected = session(&source);
        expected.poll(WorkBudget::new(3, 3)).unwrap();
        let mut delta_queue = AnalysisQueue::new();
        delta_queue.enqueue_latest(1, Revision(0), initial, None);
        let mut ticks = 0;
        while !expected.is_complete() {
            let previous = prefix.clone();
            let (_, _, progress) = delta_queue
                .poll_into(1, Revision(0), WorkBudget::new(16, 8), &mut prefix)
                .unwrap()
                .unwrap();
            let expected_progress = expected.poll(WorkBudget::new(16, 8)).unwrap();
            let expected_snapshot = expected.prefix_snapshot();
            assert_eq!(progress, expected_progress);
            assert_eq!(prefix, expected_snapshot);
            for node in previous
                .nodes()
                .iter()
                .filter(|node| node.id != previous.root().id)
            {
                assert_eq!(prefix.node(node.id), Some(node));
            }
            ticks += 1;
        }
        assert!(ticks > 100);
        // Stale work must not mutate the last published snapshot.
        let previous = prefix.clone();
        delta_queue.enqueue_latest(2, Revision(1), session("other"), None);
        assert!(
            delta_queue
                .poll_into(3, Revision(2), WorkBudget::new(1, 1), &mut prefix)
                .unwrap()
                .is_none()
        );
        assert_eq!(prefix, previous);
    }

    #[test]
    fn newest_job_supersedes_older_revision() {
        let mut queue = AnalysisQueue::new();
        let old = queue.enqueue_latest(1, Revision(1), session("old"), None);
        let latest = session("new");
        let mut prefix = latest.prefix_snapshot();
        let new = queue.enqueue_latest(1, Revision(2), latest, None);
        assert_ne!(old, new);
        let (id, revision, progress) = queue
            .poll_into(1, Revision(2), WorkBudget::new(16, 16), &mut prefix)
            .unwrap()
            .unwrap();
        assert_eq!((id, revision), (new, Revision(2)));
        assert!(progress.complete);
    }

    #[test]
    fn stale_generation_is_discarded_without_publishing() {
        let mut queue = AnalysisQueue::new();
        let stale = session("old");
        let mut prefix = stale.prefix_snapshot();
        queue.enqueue_latest(1, Revision(1), stale, None);
        assert!(
            queue
                .poll_into(2, Revision(1), WorkBudget::new(16, 16), &mut prefix)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reprioritize_changes_the_next_slice_without_replacing_the_job() {
        let source = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut queue = AnalysisQueue::new();
        let initial = session(&source);
        let mut prefix = initial.prefix_snapshot();
        let id = queue.enqueue_latest(1, Revision(1), initial, None);
        assert!(queue.reprioritize(id, 8));
        let (analysis_id, _, progress) = queue
            .poll_into(1, Revision(1), WorkBudget::new(20, 20), &mut prefix)
            .unwrap()
            .unwrap();
        assert!(!progress.complete);
        assert_eq!(analysis_id, id);
        assert!(progress.confirmed_range.to >= 8);
        assert!(progress.confirmed_range.to < source.encode_utf16().count() as u32);
    }
}
