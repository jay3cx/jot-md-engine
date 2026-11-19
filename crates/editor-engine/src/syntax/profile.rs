use editor_protocol::SyntaxProfile;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledSyntaxProfile {
    unspaced_fence_language: bool,
}

impl CompiledSyntaxProfile {
    pub fn compile(source: SyntaxProfile) -> Self {
        // 只有明确启用这个扩展版本，代码围栏才接受紧跟在反引号后的语言名。
        let unspaced_fence_language = source.enabled_extensions.iter().any(|extension| {
            extension.id == "commonmark-fence-language" && extension.version == "1.0.0"
        });
        Self {
            unspaced_fence_language,
        }
    }

    pub(crate) fn unspaced_fence_language(&self) -> bool {
        self.unspaced_fence_language
    }
}
