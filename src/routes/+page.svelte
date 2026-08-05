<script lang="ts">
	import { onMount } from 'svelte';
	import BossHealth from '$lib/BossHealth.svelte';
	import RankTimelineChart from '$lib/RankTimelineChart.svelte';
	import { decodeScoreData } from '$lib/rank-decoder';
	import { getWorldbossMeta } from '$lib/worldboss';
	import defaultChars from '$lib/data/worldboss_3_chars.json';

	let {
		worldboss = 'worldboss_3',
		chars = defaultChars
	}: { worldboss?: string; chars?: Record<string, string> } = $props();
	const worldbossMeta = getWorldbossMeta(worldboss);
	const scoreUrl = `https://gf2-api.hamelon.cfd/${worldboss}/rank/score`;
	const characterIds = Object.keys(chars).map(Number).sort((a, b) => a - b);
	type TimelinePoint = { raw: number; epoch: number };
	type CharacterScore = { id: number; name: string; score: number; rank: number };
	type ScoreSnapshot = { point: TimelinePoint; scores: Map<number, number> };
	type ChartScorePoint = { rank1: number; rank2: number; rank3: number; rank100: number };

	let snapshots = $state<ScoreSnapshot[]>([]);
	let timeline = $state<TimelinePoint[]>([]);
	let rankings = $state<CharacterScore[]>([]);
	let selectedIndex = $state(0);
	let chartScores = $state<Record<number, ChartScorePoint>>({});
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state('');
	let controller: AbortController | undefined;

	const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
	});

	async function decodeScorePayload(buffer: ArrayBuffer): Promise<ScoreSnapshot[]> {
		const decoded = await decodeScoreData(buffer, characterIds.length);
		const result: ScoreSnapshot[] = [];
		for (let snapshotIndex = 0; snapshotIndex < decoded.times.length; snapshotIndex += 1) {
			const epoch = decoded.times[snapshotIndex];
			const scores = new Map<number, number>();
			for (let characterIndex = 0; characterIndex < characterIds.length; characterIndex += 1) {
				scores.set(characterIds[characterIndex], decoded.scores[snapshotIndex * decoded.characterCount + characterIndex]);
			}
			result.push({ point: { raw: epoch, epoch }, scores });
		}
		return result.sort((a, b) => a.point.epoch - b.point.epoch);
	}

	function rankSnapshot(snapshot: ScoreSnapshot): CharacterScore[] {
		return characterIds
			.map((id) => ({ id, name: String(chars[String(id) as keyof typeof chars]), score: snapshot.scores.get(id) ?? 0, rank: 0 }))
			.sort((a, b) => b.score - a.score || a.id - b.id)
			.map((entry, index) => ({ ...entry, rank: index + 1 }));
	}

	function chartPoint(snapshot: ScoreSnapshot): ChartScorePoint {
		const ranked = rankSnapshot(snapshot);
		return {
			rank1: ranked[0]?.score ?? 0,
			rank2: ranked[1]?.score ?? 0,
			rank3: ranked[2]?.score ?? 0,
			rank100: ranked.at(-1)?.score ?? 0
		};
	}

	function selectTime(index: number) {
		const snapshot = snapshots[index];
		if (!snapshot) return;
		selectedIndex = index;
		rankings = rankSnapshot(snapshot);
	}

	function formatTime(point: TimelinePoint | undefined): string {
		if (!point) return '--:--:--';
		const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(point.epoch)).map((part) => [part.type, part.value]));
		return `${parts.month}.${parts.day}  ${parts.hour}:${parts.minute}:${parts.second}`;
	}

	async function loadScores() {
		refreshing = snapshots.length > 0;
		loading = !snapshots.length;
		error = '';
		controller?.abort();
		controller = new AbortController();
		try {
			const response = await fetch(scoreUrl, { signal: controller.signal });
			if (!response.ok) throw new Error(`请求失败 (${response.status})`);
			const decoded = await decodeScorePayload(await response.arrayBuffer());
			if (!decoded.length) throw new Error('接口未返回总分记录');
			snapshots = decoded;
			timeline = decoded.map((snapshot) => snapshot.point);
			chartScores = Object.fromEntries(decoded.map((snapshot, index) => [index, chartPoint(snapshot)]));
			selectTime(decoded.length - 1);
		} catch (reason) {
			if (reason instanceof DOMException && reason.name === 'AbortError') return;
			error = reason instanceof Error ? reason.message : '总分排行加载失败';
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	onMount(() => {
		void loadScores();
		return () => controller?.abort();
	});
</script>

<svelte:head>
	<title>{worldbossMeta.fullName} · GF2</title>
	<meta name="description" content="少女前线2：追放人形总分历史排行榜。" />
</svelte:head>

<main class="overall-page">
	<div class="overall-boss-health"><BossHealth {worldboss} selectedEpoch={timeline[selectedIndex]?.epoch} /></div>
	<header class="overall-heading">
		<div class="overall-title">
			<h1>{worldbossMeta.shortName}</h1>
			<a href="https://t.me/GF2Lib" target="_blank" rel="noreferrer" aria-label="加入频道">
				<strong>加入频道</strong>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 3.4 3.8 9.9c-1.2.5-1.2 1.1-.2 1.4l4.3 1.4 1.7 5.1c.2.6.1.8.8.8.5 0 .8-.2 1-.4l2.1-2 4.4 3.2c.8.5 1.4.3 1.6-.8l2.8-13.3c.3-1.4-.5-2.1-1.6-1.9ZM9.6 12.4l8.4-5.3c.4-.2.8-.1.5.2l-6.9 6.2-.3 3.1-1.7-4.2Z" /></svg>
			</a>
		</div>
		<div class="overall-actions">
			<div><span>记录时间</span><strong>{formatTime(timeline[selectedIndex])}</strong></div>
			<button onclick={loadScores} aria-label="刷新总分排行" title="刷新总分排行">
				<svg class:spinning={refreshing} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 9m0-4v4h4M4 13a8.1 8.1 0 0 0 14.9 4L21 15m0 4v-4h-4" /></svg>
			</button>
		</div>
	</header>

	{#if loading}
		<section class="overall-content overall-loading" aria-label="正在载入人形排行">
			<div class="podium-grid">
				{#each Array(3) as _, index}
					<div class:champion={index === 0} class="podium-card podium-skeleton">
						<div class="loading-shimmer rank-skeleton"></div>
						<div class="loading-shimmer art-skeleton"></div>
						<div class="loading-shimmer info-skeleton"></div>
					</div>
				{/each}
			</div>
			<div class="overall-list">
				{#each Array(12) as _}
					<div class="overall-row row-skeleton">
						<i class="loading-shimmer"></i><i class="loading-shimmer"></i><i class="loading-shimmer"></i><i class="loading-shimmer"></i>
					</div>
				{/each}
			</div>
		</section>
	{:else if error && !rankings.length}
		<div class="overall-state error"><strong>无法读取总分排行</strong><span>{error}</span><button onclick={loadScores}>重试</button></div>
	{:else}
		<section class="overall-content">
			<div class="podium-grid">
				{#each rankings.slice(0, 3) as entry}
					<a class:champion={entry.rank === 1} class={`podium-card podium-${entry.rank}`} href={`/${worldboss}/${entry.id}`}>
						<div class="podium-art"><img src={`/Pic/${entry.id}.png`} alt={entry.name} /></div>
						<div class="podium-rank"><span>排名</span><strong>{entry.rank}</strong></div>
						<div class="podium-info"><strong>{entry.name}</strong><span>{entry.score}</span></div>
					</a>
				{/each}
			</div>

			<div class="overall-list">
				{#each rankings.slice(3) as entry}
					<a href={`/${worldboss}/${entry.id}`} class="overall-row">
						<strong>{String(entry.rank).padStart(2, '0')}</strong>
						<img src={`/Avatar/${entry.id}.png`} alt="" />
						<span>{entry.name}</span>
						<b>{entry.score}</b>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section class="timeline-panel" aria-label="人形总分时间轴">
		{#if loading}
			<div class="timeline-loading"><span></span>正在读取有效时间点</div>
		{:else if error && !timeline.length}
			<div class="timeline-error"><span>{error}</span><button onclick={loadScores}>重试</button></div>
		{:else}
			<RankTimelineChart {timeline} scores={chartScores} {selectedIndex} lastRankLabel={`第 ${characterIds.length} 名`} onSelect={selectTime} onRangeChange={() => {}} />
		{/if}
	</section>
</main>

<style>
	.overall-page { width:100%; height:100dvh; min-height:0; padding:0 0 150px; overflow:hidden; color:#25292c; }
	.overall-boss-health { width:100%; margin:0 0 8px; }
	.overall-heading,.overall-content,.overall-state { width:min(1120px,calc(100% - 40px)); margin-left:auto; margin-right:auto; }
	.overall-heading { min-height:56px; display:flex; align-items:center; justify-content:space-between; margin-top:24px; margin-bottom:20px; padding:0 17px; }
	.overall-heading h1 { margin:0; font-size:24px; line-height:1; font-weight:900; letter-spacing:0; }
	.overall-title { display:flex; align-items:center; gap:18px; }
	.overall-title > a { height:30px; padding:0 9px 0 12px; display:flex; align-items:center; justify-content:center; gap:6px; color:#fff; background:#2da9df; border-radius:16px; text-decoration:none; transform:translateY(2px); }
	.overall-title > a strong { font-size:12px; line-height:1; white-space:nowrap; }
	.overall-title > a svg { width:17px; height:17px; display:block; flex:0 0 auto; fill:currentColor; }
	.overall-actions { display:flex; align-items:center; gap:17.7px; }
	.overall-actions > div { display:grid; gap:2px; text-align:right; }
	.overall-actions > div span { color:#747a80; font-size:11px; font-weight:800; letter-spacing:0; }
	.overall-actions > div strong { color:#202327; font:800 16px Consolas,monospace; }
	.overall-actions button { width:42px; height:42px; display:grid; place-items:center; color:#fff; background:#34383b; border:1px solid #555b5f; border-radius:3px;}
	.overall-actions svg { width:24px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
	.overall-content { display:grid; grid-template-columns:.78fr 1fr; gap:18px; align-items:start; }
	.podium-grid { grid-column:2; align-self:center; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
	.podium-card { position:relative; min-height:210px; overflow:visible; color:#272b2e; background:#cfd2d4; border:8px solid rgba(191,195,197,.72); border-radius:22px; box-shadow:0 5px 14px rgba(34,38,41,.2); text-decoration:none; }
	.podium-card.champion { grid-column:1/-1; min-height:250px; }
	.podium-card::before { content:''; position:absolute; inset:5px 5px 48px; border:4px solid #f7f7f7; border-radius:15px; background:radial-gradient(circle at 52% 45%,rgba(255,255,255,.26),transparent 36%),linear-gradient(120deg,#666b6e,#bfc3c5 48%,#7c8285); box-shadow:0 2px 8px rgba(42,46,49,.22); overflow:hidden; }
	.podium-1::before { background:linear-gradient(118deg,transparent 0 66%,rgba(255,179,86,.9) 66% 71%,rgba(233,59,96,.8) 71% 77%,rgba(77,124,255,.72) 77% 84%,transparent 84%),radial-gradient(circle at 50% 58%,transparent 0 58px,rgba(255,255,255,.1) 59px 108px,transparent 109px),linear-gradient(125deg,#515658 0%,#7f8588 46%,#a97791 72%,#75cde1 100%); }
	.podium-2::before { background:radial-gradient(circle at 52% 62%,transparent 0 45px,rgba(255,255,255,.11) 46px 82px,transparent 83px),linear-gradient(125deg,#666b6e,#d09a51 72%,#c2c5c6); }
	.podium-3::before { background:radial-gradient(circle at 52% 62%,transparent 0 45px,rgba(255,255,255,.11) 46px 82px,transparent 83px),linear-gradient(125deg,#666b6e,#758bd6 72%,#c2c5c6); }
	.podium-art { position:absolute; z-index:1; left:9px; right:9px; top:9px; bottom:52px; overflow:hidden; border-radius:11px; pointer-events:none; }
	.podium-card img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center -24px; filter:drop-shadow(8px 9px 5px rgba(20,23,25,.46)); }
	.podium-card:not(.champion) img { object-position:center -12px; transform:scale(1.25); transform-origin:50% 45%; }
	.podium-card.champion img { object-position:center -46px; }
	.podium-rank { position:absolute; z-index:3; top:-5px; left:-5px; min-width:112px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; color:#fff; background:#292d30; border:5px solid #111; border-radius:14px; box-shadow:0 4px 7px rgba(0,0,0,.32); }
	.podium-rank span { font-size:15px; font-weight:900; }
	.podium-rank strong { color:#e93b60; font-size:43px; line-height:.8; }
	.podium-2 .podium-rank strong { color:#ffb356; }
	.podium-3 .podium-rank strong { color:#4d7cff; }
	.podium-info { position:absolute; z-index:2; inset:auto 8px 3px; height:43px; padding:4px 8px; display:flex; align-items:center; justify-content:space-between; color:#292d30; background:transparent; }
	.podium-info strong { font-size:22px; }
	.podium-info span { font-size:21px; font-weight:900; }
	.overall-list { grid-column:1; grid-row:1; height:max(240px,calc(100dvh - 160px)); min-height:0; display:grid; align-content:start; gap:8px; overflow:auto; padding-bottom:80px; scrollbar-width:none; -ms-overflow-style:none; }
	.overall-list::-webkit-scrollbar { display:none; }
	.overall-row { min-height:66px; padding:5px 18px 5px 14px; display:grid; grid-template-columns:66px 48px 1fr auto; align-items:center; gap:10px; overflow:hidden; color:#f4f5f5; background:#3b3f42; border:3px solid #c3c6c8; border-radius:34px; text-decoration:none; box-shadow:inset 5px 0 #8b9195; }
	.overall-row > strong { width:100%; padding-right:4px; font-size:26px; line-height:1; font-style:italic; text-align:center; transform:translate(-10px,-1px); }
	.overall-row img { width:46px; height:46px; object-fit:cover; border:2px solid #858c90; border-radius:50%; }
	.overall-row span { overflow:hidden; font-size:18px; font-weight:800; text-overflow:ellipsis; white-space:nowrap; }
	.overall-row b { font-size:19px; font-variant-numeric:tabular-nums; }
	.overall-state { min-height:420px; display:grid; place-content:center; justify-items:center; gap:10px; border:1px dashed #9da3a7; }
	.overall-state.error button { padding:8px 18px; color:#fff; background:#34383b; border:0; }
	.podium-skeleton { overflow:hidden; }
	.loading-shimmer { display:block; background:linear-gradient(90deg,#b8bdc0 22%,#e0e3e4 42%,#b8bdc0 62%) 0 0/260% 100%; animation:overall-shimmer 1.45s linear infinite; }
	.art-skeleton { position:absolute; inset:9px 9px 52px; border-radius:11px; }
	.rank-skeleton { position:absolute; z-index:2; top:10px; left:10px; width:105px; height:54px; border-radius:10px; }
	.info-skeleton { position:absolute; left:16px; right:16px; bottom:13px; height:17px; }
	.row-skeleton i { height:14px; border-radius:7px; }
	.row-skeleton i:nth-child(1) { width:38px; }
	.row-skeleton i:nth-child(2) { width:42px; height:42px; border-radius:50%; }
	.row-skeleton i:nth-child(3) { width:min(150px,72%); }
	.row-skeleton i:nth-child(4) { width:82px; justify-self:end; }
	@keyframes overall-shimmer { to { background-position:-160% 0; } }
	@media(max-width:760px) {
		.overall-page { height:auto; min-height:100vh; padding:0 0 40px; overflow:visible; }
		.overall-heading,.overall-content,.overall-state { width:calc(100% - 12px); }
		.overall-boss-health { width:100%; margin-bottom:6px; padding:0; }
		.overall-heading { min-height:46px; padding:0 10px; margin-top:12px; margin-bottom:15px; }
		.overall-heading h1 { font-size:20px; }
		.overall-title { gap:10px; }
		.overall-title > a { height:28px; padding:0 7px 0 9px; gap:4px; }
		.overall-title > a strong { font-size:11px; }
		.overall-title > a svg { width:15px; height:15px; }
		.overall-actions { gap:8px; }
		.overall-actions > div span { font-size:9px; }
		.overall-actions > div strong { font-size:11px; }
		.overall-content { display:flex; flex-direction:column; }
		.podium-grid { width:100%; }
		.podium-card { min-height:160px; }
		.podium-card.champion { min-height:195px; }
		.podium-card img { object-position:center -16px; }
		.podium-card:not(.champion) img { object-position:center -8px; transform:scale(1.18); }
		.podium-card.champion img { object-position:center -28px; }
		.podium-rank { min-width:84px; padding:7px 9px; }
		.podium-rank strong { font-size:32px; }
		.podium-info strong,.podium-info span { font-size:16px; }
		.overall-list { width:100%; height:auto; min-height:0; }
		.overall-row { grid-template-columns:48px 40px 1fr auto; min-height:58px; padding-inline:10px; }
		.overall-row img { width:38px; height:38px; }
		.overall-row span,.overall-row b { font-size:14px; }
	}
</style>
