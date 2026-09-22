const EXPECTED_SUPERVISED_GUIDES = Object.freeze({
  windows: 'https://financialbrain.ai/install/agent.md',
  macos: 'https://financialbrain.ai/install/agent-macos.md',
});

export function expectedSupervisedGuideUrl(platform) {
  return Object.hasOwn(EXPECTED_SUPERVISED_GUIDES, platform)
    ? EXPECTED_SUPERVISED_GUIDES[platform]
    : null;
}

export function matchesExpectedSupervisedGuideUrl(platform, actualUrl) {
  const expectedUrl = expectedSupervisedGuideUrl(platform);
  return expectedUrl !== null && actualUrl === expectedUrl;
}
