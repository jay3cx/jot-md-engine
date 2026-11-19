use std::collections::HashSet;

use editor_engine::syntax::SyntaxSnapshot;

/// 增量解析会复用节点 ID。比较节点的内容、顺序和源码范围，另行检查每个节点只出现一次。
pub fn assert_same_syntax(actual: &SyntaxSnapshot, expected: &SyntaxSnapshot) {
    let mut reachable = HashSet::new();
    let mut pending = vec![(actual.root().id, expected.root().id)];
    while let Some((actual_id, expected_id)) = pending.pop() {
        assert!(
            reachable.insert(actual_id),
            "duplicate or cyclic node {actual_id:?}"
        );
        let a = actual.node(actual_id).unwrap();
        let b = expected.node(expected_id).unwrap();
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.source_range, b.source_range);
        assert_eq!(a.children.len(), b.children.len());
        pending.extend(a.children.iter().copied().zip(b.children.iter().copied()));
    }
    assert_eq!(reachable.len(), actual.nodes().len(), "orphaned nodes");
}
