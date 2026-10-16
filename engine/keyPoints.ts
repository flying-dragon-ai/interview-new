/**
 * 题目核心要点提取（沿用现有正则规则，PRD 4.1.3：要点跟踪每要点 10 次保留）
 * 从 geminiService.ts / DiscussionPanel.tsx 双份实现收敛为单一模块。
 */

/** 从「核心要点」段提取 */
function extractFromSection(text: string, header: string): string[] {
  const match = text.match(new RegExp(`${header}[：:]\\s*([\\s\\S]*?)(?=\\n\\n|\\n三、|$)`));
  if (!match) return [];
  const points: string[] = [];
  const pointRegex = /\d+[、.]\s*([^0-9\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pointRegex.exec(match[1])) !== null) {
    const point = m[1].trim();
    if (point) points.push(point);
  }
  return points;
}

/** 提取题目核心要点（保留完整要点，不拆分「与/和」） */
export function extractKeyPoints(topicText: string): string[] {
  if (!topicText) return [];
  let points = extractFromSection(topicText, '核心要点');
  if (points.length === 0) points = extractFromSection(topicText, '要点');
  if (points.length === 0) points = extractFromSection(topicText, '问题');
  return points;
}

/** 每个要点最大讨论次数（AI + 用户，沿用现有规则） */
export const MAX_DISCUSSIONS_PER_KEY_POINT = 10;
