import { criteriaLabel, periodLabel, participantLabel } from "./lottery-core.js";

export function createRecord({ post, settings, participants, commentsCount, cutoff, asOf, completed, phase, tone, message, draws, logs }, exportedAt = Date.now()) {
  const link = (person) => {
    const url = new URL(post.url);
    url.searchParams.set("fcno", person.firstCommentId);
    return url.href;
  };
  const personRecord = (person) => ({
    name: person.name,
    identityCode: person.identityCode || "",
    displayName: participantLabel(person),
    identityType: person.identityType,
    entryCommentId: person.firstCommentId,
    entryCommentUrl: link(person),
    entryCommentCount: person.commentCount,
    profileStatus: person.profileStatus || "not-checked",
    status: person.status,
    reason: person.reason,
    automaticStatus: person.automaticStatus || person.status,
    automaticReason: person.automaticReason ?? person.reason,
    included: person.included ?? person.status === "eligible",
    manuallyExcluded: Boolean(person.manuallyExcluded),
    confirmedPosts: !person.exclusion && (settings.minPosts > 0 || settings.minTotal > 0) ? person.postCount : null,
    confirmedComments: person.commentsChecked ? person.activityCommentCount : null,
    confirmedTotal: !person.exclusion && (settings.minPosts > 0 || settings.minComments > 0 || settings.minTotal > 0) ? person.totalActivityCount : null,
    postsComplete: !person.exclusion && (settings.minPosts > 0 || settings.minTotal > 0) ? Boolean(person.postsComplete) : null,
    commentsComplete: person.commentsChecked ? Boolean(person.commentsComplete) : null,
    lastActivity: person.lastActivity ? new Date(person.lastActivity).toISOString() : null,
  });
  return {
    format: "boogie-lottery-record",
    schemaVersion: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    source: { title: post.title || "", url: post.url, galleryId: post.id, galleryType: post.type, postNo: post.no },
    run: { startedAt: new Date(asOf).toISOString(), completed, phase, tone, message },
    settings: {
      winnerCount: settings.winnerCount,
      periodUnit: settings.periodUnit,
      periodValue: settings.periodUnit === "all" ? null : settings.periodValue,
      activityMode: settings.activityMode,
      minPosts: settings.minPosts, minComments: settings.minComments, minTotal: settings.minTotal,
      requirePublicGallog: settings.requirePublicGallog,
      includeReplies: settings.includeReplies, excludeAuthor: settings.excludeAuthor, keyword: settings.keyword,
    },
    assessment: { from: settings.periodUnit === "all" ? null : new Date(cutoff).toISOString(), through: new Date(asOf).toISOString(), datePrecision: "day", countsAreLowerBounds: true },
    summary: {
      commentsCollected: commentsCount,
      participants: participants.length,
      eligible: participants.filter((person) => person.status === "eligible").length,
      automaticEligible: participants.filter((person) => (person.automaticStatus || person.status) === "eligible").length,
      excluded: participants.filter((person) => person.status === "excluded").length,
      pending: participants.filter((person) => person.status === "pending").length,
    },
    participants: participants.map(personRecord),
    latestDrawId: draws.at(-1)?.id || null,
    draws: draws.map((draw, index) => ({ id: draw.id, sequence: index + 1, winnerCount: draw.winners.length, at: new Date(draw.at).toISOString(),
      winners: draw.winners.map((person, rank) => ({ rank: rank + 1, ...personRecord(person) })) })),
    logs: { retainedLimit: 120, entries: logs.map((entry) => ({ ...entry })) },
  };
}

export function jsonBlob(record) {
  return new Blob([JSON.stringify(record, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
}

export function exportBaseName(record) {
  const suffix = record.latestDrawId?.slice(0, 8) || record.exportedAt.replace(/\D/g, "");
  return "boogie-result-" + record.source.galleryId + "-" + record.source.postNo + "-" + suffix;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const fontFamily = '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
const dateTime = (value) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
const dateOnly = (value) => new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
function wrapLines(context, value, maxWidth, font) {
  context.font = font;
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(value))].map((item) => item.segment)
    : Array.from(String(value));
  const lines = [];
  let line = "";
  for (const character of segments) {
    if (character === "\n") { lines.push(line); line = ""; continue; }
    if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = character; }
    else line += character;
  }
  lines.push(line);
  return lines;
}

export async function pngBlob(record) {
  const draw = record.draws.at(-1);
  if (!draw) throw new Error("추첨 완료 후 PNG를 저장할 수 있습니다.");
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const width = 1080;
  canvas.width = width;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서 PNG를 만들 수 없습니다.");
  const commands = [];
  let y = 52;
  const text = (value, size = 23, color = "#bcecc7", weight = 400) => {
    const font = weight + " " + size + "px " + fontFamily;
    const lines = wrapLines(context, value, 968, font);
    commands.push({ type: "text", x: 56, y, lines, font, color, lineHeight: Math.ceil(size * 1.55) });
    y += lines.length * Math.ceil(size * 1.55);
  };
  text("부기 추첨자 / 추첨 결과", 22, "#52e883", 700);
  y += 16;
  text(record.source.title || "제목 없는 게시글", 34, "#e1ffe8", 700);
  y += 18;
  text(periodLabel(record.settings) + " · " + criteriaLabel(record.settings));
  text("평가 대상: " + record.source.galleryId + " · 공개 갤로그 필수", 21, "#8fba9b");
  if (record.assessment.from) text("평가기간: " + dateOnly(record.assessment.from) + " ~ " + dateOnly(record.assessment.through), 21, "#8fba9b");
  text("참여 조건: " + (record.settings.includeReplies ? "대댓글 포함" : "대댓글 제외") + " · "
    + (record.settings.excludeAuthor ? "글쓴이 제외" : "글쓴이 포함") + " · "
    + (record.settings.keyword ? "키워드 ‘" + record.settings.keyword + "’" : "키워드 제한 없음"), 21, "#8fba9b");
  y += 16;
  text("참가 " + record.summary.participants + "명 / 포함 " + record.summary.eligible + "명 / 불포함 "
    + record.summary.excluded + "명 / 미확인 " + record.summary.pending + "명", 25, "#e1ffe8", 700);
  y += 30;
  text("당첨자 " + draw.winners.length + "명", 26, "#52e883", 700);
  y += 14;
  const columns = draw.winners.length > 1 ? 2 : 1;
  const cardWidth = (968 - (columns - 1) * 20) / columns;
  const nameFont = "700 26px " + fontFamily;
  const detailFont = "400 19px " + fontFamily;
  for (let index = 0; index < draw.winners.length; index += columns) {
    const row = draw.winners.slice(index, index + columns).map((person, column) => {
      const name = wrapLines(context, participantLabel(person), cardWidth - 48, nameFont);
      const details = [person.confirmedPosts !== null ? "글 " + person.confirmedPosts + "개" : "",
        person.confirmedComments !== null ? "댓글 " + person.confirmedComments + "개" : "", "참여 " + person.entryCommentCount + "개"].filter(Boolean).join(" · ");
      const lines = wrapLines(context, details, cardWidth - 48, detailFont);
      return { type: "card", x: 56 + column * (cardWidth + 20), y, width: cardWidth, rank: person.rank,
        name, details: lines, height: 83 + name.length * 38 + lines.length * 29 };
    });
    const height = Math.max(...row.map((card) => card.height));
    for (const card of row) commands.push({ ...card, height });
    y += height + 18;
  }
  y += 10;
  text("추첨 시각: " + dateTime(draw.at), 20, "#8fba9b");
  text("추첨 번호: " + draw.id, 20, "#8fba9b");
  text("확인한 활동 수는 최소 건수입니다. 같은 계정은 1명으로 처리합니다.", 18, "#8fba9b");
  y += 12;
  text("원문: " + record.source.url, 18, "#8fba9b");
  const height = Math.ceil(y + 46);
  const scale = Math.min(1, 12_000 / height, Math.sqrt(12_000_000 / (width * height)));
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  context.scale(scale, scale);
  context.fillStyle = "#080f0b";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#315d3f";
  context.lineWidth = 2;
  context.strokeRect(20, 20, width - 40, height - 40);
  context.textBaseline = "top";
  const paintLines = (lines, x, top, font, color, lineHeight) => {
    context.font = font; context.fillStyle = color;
    lines.forEach((line, index) => context.fillText(line, x, top + index * lineHeight));
  };
  for (const command of commands) {
    if (command.type === "text") paintLines(command.lines, command.x, command.y, command.font, command.color, command.lineHeight);
    else {
      context.fillStyle = "#0b1b10"; context.strokeStyle = "#376648";
      context.fillRect(command.x, command.y, command.width, command.height);
      context.strokeRect(command.x, command.y, command.width, command.height);
      paintLines([String(command.rank).padStart(2, "0")], command.x + 24, command.y + 18, "700 20px " + fontFamily, "#52e883", 30);
      paintLines(command.name, command.x + 24, command.y + 52, nameFont, "#e1ffe8", 38);
      paintLines(command.details, command.x + 24, command.y + 62 + command.name.length * 38, detailFont, "#8fba9b", 29);
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG 생성에 실패했습니다.")), "image/png"));
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

// PNG is already compressed; store the two files in a standard, uncompressed ZIP.
export async function zipBlob(files, modifiedAt = Date.now()) {
  const parts = [];
  const central = [];
  let offset = 0;
  const modified = new Date(modifiedAt);
  const dosDate = ((Math.max(1980, Math.min(2107, modified.getFullYear())) - 1980) << 9)
    | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const dosTime = (modified.getHours() << 11) | (modified.getMinutes() << 5) | Math.floor(modified.getSeconds() / 2);
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); header.setUint16(6, 0x0800, true);
    header.setUint16(10, dosTime, true); header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true); header.setUint32(22, bytes.length, true);
    header.setUint16(26, name.length, true); local.set(name, 30);
    parts.push(local, bytes);
    const directory = new Uint8Array(46 + name.length);
    const entry = new DataView(directory.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, dosTime, true); entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true); entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true); directory.set(name, 46);
    central.push(directory);
    offset += local.length + bytes.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, files.length, true); footer.setUint16(10, files.length, true);
  footer.setUint32(12, centralSize, true); footer.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
