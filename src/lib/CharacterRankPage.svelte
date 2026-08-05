<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { fade } from 'svelte/transition';
	import BossHealth from '$lib/BossHealth.svelte';
	import RankTimelineChart from '$lib/RankTimelineChart.svelte';
	import { decodeRankData, decodeScoreData } from '$lib/rank-decoder';
	import { getWorldbossMeta } from '$lib/worldboss';
	import defaultChars from '$lib/data/worldboss_3_chars.json';

	const DRAG_UPDATE_INTERVAL = 70;
	let {
		initialRankId = 1078,
		worldboss = 'worldboss_3',
		chars = defaultChars
	}: { initialRankId?: number; worldboss?: string; chars?: Record<string, string> } = $props();
	const worldbossMeta = getWorldbossMeta(worldboss);
	const popularityUrl = `https://gf2-api.hamelon.cfd/${worldboss}/rank/score`;
	const supporters = Object.entries(chars)
		.map(([id, name]) => ({ id: Number(id), name }))
		.sort((a, b) => a.id - b.id);

	type JsonRecord = Record<string, unknown>;
	type TimelinePoint = {
		raw: string | number;
		epoch: number;
	};
	type RankEntry = {
		id: string;
		name: string;
		level: string;
		score: number;
		rank: number;
		previousRank?: number;
	};
	type ChartScorePoint = {
		rank1: number;
		rank2: number;
		rank3: number;
		rank100: number;
	};
	type RankSnapshot = {
		point: TimelinePoint;
		entries: RankEntry[];
	};
	type SupporterPopularity = { score: number; rank: number };

	let timeline = $state<TimelinePoint[]>([]);
	let selectedIndex = $state(0);
	let displayedIndex = $state(0);
	let ranks = $state<RankEntry[]>([]);
	let timelineLoading = $state(true);
	let rankLoading = $state(true);
	let rankRefreshing = $state(false);
	let timelineError = $state('');
	let rankError = $state('');
	let supporterPanelOpen = $state(false);
	let rankId = $state(initialRankId);
	let supporterSortMode = $state<'default' | 'popularity'>('popularity');
	let supporterSortMenuOpen = $state(false);
	let supporterSortDescending = $state(false);
	let chartScores = $state<Record<number, ChartScorePoint>>({});
	let snapshots = $state<RankSnapshot[]>([]);
	let supporterPopularity = $state<Map<number, SupporterPopularity>>(new Map());
	let rankController: AbortController | undefined;
	let popularityController: AbortController | undefined;
	let dragBaseline: RankEntry[] | undefined;
	let queuedDragIndex: number | undefined;
	let dragRequestRunning = false;
	let dragging = false;
	let lastDragRequestAt = 0;

	const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});

	function isRecord(value: unknown): value is JsonRecord {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function firstValue(record: JsonRecord, keys: string[]): unknown {
		for (const key of keys) {
			if (record[key] !== undefined && record[key] !== null) return record[key];
		}
		return undefined;
	}

	function normalizeKey(key: string): string {
		return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
	}

	function deepFirstValue(value: unknown, keys: string[], maxDepth = 5): unknown {
		const wanted = new Set(keys.map(normalizeKey));
		const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
		const visited = new Set<object>();

		while (queue.length) {
			const current = queue.shift()!;
			if (!isRecord(current.value) || visited.has(current.value)) continue;
			visited.add(current.value);

			for (const [key, child] of Object.entries(current.value)) {
				if (wanted.has(normalizeKey(key)) && child !== undefined && child !== null) return child;
			}
			if (current.depth >= maxDepth) continue;
			for (const child of Object.values(current.value)) {
				if (isRecord(child)) queue.push({ value: child, depth: current.depth + 1 });
				else if (Array.isArray(child) && child.length === 1 && isRecord(child[0])) {
					queue.push({ value: child[0], depth: current.depth + 1 });
				}
			}
		}
		return undefined;
	}

	function unwrapArray(payload: unknown, preferredKeys: string[]): unknown[] {
		if (Array.isArray(payload)) return payload;
		if (!isRecord(payload)) return [];

		for (const key of [...preferredKeys, 'data', 'result']) {
			const value = payload[key];
			if (Array.isArray(value)) return value;
			if (isRecord(value)) {
				const nested = unwrapArray(value, preferredKeys);
				if (nested.length) return nested;
				const values = Object.values(value);
				if (values.length && values.every(isRecord)) return values;
			}
		}
		const values = Object.values(payload);
		if (values.length && values.every(isRecord)) return values;
		return [];
	}

	function toEpoch(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value < 10_000_000_000 ? value * 1000 : value;
		}
		if (typeof value !== 'string' || !value.trim()) return undefined;
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	function normalizeTimeline(payload: unknown): TimelinePoint[] {
		const source = unwrapArray(payload, ['timeline', 'times', 'timestamps', 'points']);
		const points = source.flatMap((item) => {
			const raw = isRecord(item)
				? firstValue(item, ['time', 'timestamp', 'created_at', 'createdAt', 'date'])
				: item;
			const epoch = toEpoch(raw);
			return epoch === undefined || (typeof raw !== 'string' && typeof raw !== 'number')
				? []
				: [{ raw, epoch }];
		});

		return points
			.sort((a, b) => a.epoch - b.epoch)
			.filter((point, index, values) => index === 0 || point.epoch !== values[index - 1].epoch);
	}

	function asNumber(value: unknown, fallback = 0): number {
		const parsed = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function extractRankRows(payload: unknown): unknown[] {
		const candidates: { rows: unknown[]; depth: number }[] = [];
		const visited = new Set<object>();

		function visit(value: unknown, depth: number) {
			if (depth > 6 || typeof value !== 'object' || value === null || visited.has(value)) return;
			visited.add(value);
			if (Array.isArray(value)) {
				if (value.length && value.every(isRecord)) candidates.push({ rows: value, depth });
				for (const child of value) visit(child, depth + 1);
				return;
			}
			for (const child of Object.values(value)) visit(child, depth + 1);
		}

		visit(payload, 0);
		if (!candidates.length) return unwrapArray(payload, ['ranks', 'rank', 'ranking', 'list', 'items', 'records']);

		const signalKeys = [
			'rank', 'ranking', 'position', 'name', 'player_name', 'nickname', 'username',
			'score', 'total_score', 'assist', 'assistance', 'contribution', 'points'
		];
		return candidates.sort((a, b) => {
			const score = (candidate: { rows: unknown[]; depth: number }) => {
				const sample = candidate.rows.slice(0, 3);
				const signals = sample.reduce(
					(total, row) => total + signalKeys.filter((key) => deepFirstValue(row, [key], 3) !== undefined).length,
					0
				);
				return signals * 100 + Math.min(candidate.rows.length, 100) * 4 + candidate.depth;
			};
			return score(b) - score(a);
		})[0].rows;
	}

	function normalizeRanks(payload: unknown, previous: RankEntry[]): RankEntry[] {
		const source = extractRankRows(payload);
		const previousById = new Map(previous.map((entry) => [entry.id, entry.rank]));
		const normalized = source.map((item, index) => {
			const record = isRecord(item) ? item : {};
			const nameValue = deepFirstValue(record, [
				'name',
				'player_name',
				'playerName',
				'nickname',
				'username',
				'display_name',
				'displayName',
				'gun_name',
				'gunName'
			]);
			const name = String(nameValue ?? `未知档案 ${index + 1}`);
			const idValue = deepFirstValue(record, [
				'user_id',
				'userId',
				'player_id',
				'playerId',
				'gun_id',
				'gunId',
				'uid',
				'id'
			]);
			const score = asNumber(
				deepFirstValue(record, [
					'score',
					'points',
					'point',
					'total_score',
					'totalScore',
					'total_assistance',
					'totalAssistance',
					'contribution',
					'support_score',
					'power',
					'assist',
					'assist_count',
					'assistCount',
					'assist_num',
					'assistNum',
					'assistance',
					'value',
					'count'
				])
			);
			const rank = asNumber(deepFirstValue(record, ['rank', 'ranking', 'position', 'place']), index + 1);
			const id = String(idValue ?? name);

			return {
				id,
				name,
				level: String(deepFirstValue(record, ['level', 'lv', 'player_level', 'playerLevel', 'gun_level']) ?? '--'),
				score,
				rank,
				previousRank: previousById.get(id)
			};
		});

		return normalized.sort((a, b) => a.rank - b.rank || b.score - a.score);
	}

	function formatTime(point: TimelinePoint | undefined, includeDate = true): string {
		if (!point) return '--:--:--';
		const parts = dateFormatter.formatToParts(new Date(point.epoch));
		const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
		return includeDate
			? `${values.month}.${values.day}  ${values.hour}:${values.minute}:${values.second}`
			: `${values.hour}:${values.minute}`;
	}

	function scoreWidth(score: number): number {
		const highest = ranks[0]?.score || 1;
		return Math.max(7, Math.min(100, (score / highest) * 100));
	}

	function rankMovement(entry: RankEntry): 'up' | 'down' | 'same' | 'new' {
		if (entry.previousRank === undefined) return 'new';
		if (entry.rank < entry.previousRank) return 'up';
		if (entry.rank > entry.previousRank) return 'down';
		return 'same';
	}

	function movementAmount(entry: RankEntry): number {
		return Math.abs(entry.rank - (entry.previousRank ?? entry.rank));
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (supporterSortMenuOpen) supporterSortMenuOpen = false;
		else supporterPanelOpen = false;
	}

	function selectSupporterSortMode(mode: 'default' | 'popularity') {
		supporterSortMode = mode;
		supporterSortMenuOpen = false;
	}

	function handleSortFocusOut(event: FocusEvent) {
		const container = event.currentTarget as HTMLElement;
		if (!container.contains(event.relatedTarget as Node | null)) supporterSortMenuOpen = false;
	}

	function avatarUrl(id: number): string {
		return `/Avatar/${id}.png`;
	}

	function selectedSupporterName(): string {
		return String(chars[String(rankId) as keyof typeof chars] ?? `人形 ${rankId}`);
	}

	function sortedSupporters() {
		const sorted = supporterSortMode === 'popularity'
			? [...supporters].sort((a, b) =>
				(supporterPopularity.get(a.id)?.rank ?? Number.POSITIVE_INFINITY) -
				(supporterPopularity.get(b.id)?.rank ?? Number.POSITIVE_INFINITY) || a.id - b.id
			)
			: [...supporters];
		return supporterSortDescending ? sorted.reverse() : sorted;
	}

	async function selectSupporter(id: number) {
		supporterPanelOpen = false;
		if (id === rankId) return;
		rankController?.abort();
		void goto(`/${worldboss}/${id}`, { noScroll: true, keepFocus: true });
		rankId = id;
		timeline = [];
		snapshots = [];
		chartScores = {};
		ranks = [];
		selectedIndex = 0;
		displayedIndex = 0;
		timelineLoading = true;
		rankLoading = true;
		await loadTimeline();
	}

	function normalizeSnapshots(payload: unknown): RankSnapshot[] {
		const byTime = new Map<number, RankSnapshot>();
		const flatRowsByTime = new Map<number, { raw: string | number; rows: JsonRecord[] }>();
		const visited = new Set<object>();
		const timeKeys = ['time', 'timestamp', 'record_time', 'recordTime', 'snapshot_time', 'snapshotTime', 'created_at', 'createdAt', 'date'];

		function addSnapshot(rawTime: unknown, value: unknown) {
			const epoch = toEpoch(rawTime);
			if (epoch === undefined) return;
			const rows = extractRankRows(value);
			if (!rows.length) return;
			byTime.set(epoch, {
				point: { raw: rawTime as string | number, epoch },
				entries: normalizeRanks(rows, []).map((entry) => ({ ...entry, previousRank: undefined }))
			});
		}

		function visit(value: unknown, depth: number) {
			if (depth > 7 || typeof value !== 'object' || value === null || visited.has(value)) return;
			visited.add(value);

			if (Array.isArray(value)) {
				for (const child of value) {
					if (isRecord(child)) {
						const rawTime = firstValue(child, timeKeys);
						if (rawTime !== undefined) {
							addSnapshot(rawTime, child);
							const directRank = firstValue(child, ['rank', 'ranking', 'position', 'place']);
							const epoch = toEpoch(rawTime);
							if (epoch !== undefined && (typeof directRank === 'number' || typeof directRank === 'string')) {
								const group = flatRowsByTime.get(epoch) ?? {
									raw: rawTime as string | number,
									rows: []
								};
								group.rows.push(child);
								flatRowsByTime.set(epoch, group);
							}
						}
					}
					visit(child, depth + 1);
				}
				return;
			}

			const directTime = firstValue(value, timeKeys);
			if (directTime !== undefined) addSnapshot(directTime, value);
			for (const [key, child] of Object.entries(value)) {
				if (toEpoch(key) !== undefined) addSnapshot(key, child);
				visit(child, depth + 1);
			}
		}

		visit(payload, 0);
		for (const [epoch, group] of flatRowsByTime) {
			if (byTime.has(epoch)) continue;
			byTime.set(epoch, {
				point: { raw: group.raw, epoch },
				entries: normalizeRanks(group.rows, []).map((entry) => ({ ...entry, previousRank: undefined }))
			});
		}
		return [...byTime.values()].sort((a, b) => a.point.epoch - b.point.epoch);
	}

	function scoresFromRanks(entries: RankEntry[]): ChartScorePoint {
		const scoreAt = (rank: number) =>
			entries.find((entry) => entry.rank === rank)?.score ?? entries[rank - 1]?.score ?? 0;
		return {
			rank1: scoreAt(1),
			rank2: scoreAt(2),
			rank3: scoreAt(3),
			rank100: scoreAt(100)
		};
	}

	async function decodeGunRanks(buffer: ArrayBuffer): Promise<RankSnapshot[]> {
		const decoded = await decodeRankData(buffer);
		const decodedSnapshots: RankSnapshot[] = [];
		for (let snapshotIndex = 0; snapshotIndex < decoded.times.length; snapshotIndex += 1) {
			const epoch = decoded.times[snapshotIndex];
			const entries: RankEntry[] = [];
			const start = decoded.offsets[snapshotIndex];
			const end = decoded.offsets[snapshotIndex + 1];
			for (let index = start; index < end; index += 1) {
				const uid = decoded.uids[index];
				const info = decoded.info.get(uid);
				entries.push({
					id: String(uid),
					name: info?.name ?? `UID ${uid}`,
					level: info ? String(info.level) : '--',
					score: decoded.scores[index],
					rank: index - start + 1
				});
			}
			decodedSnapshots.push({ point: { raw: epoch, epoch }, entries });
		}
		return decodedSnapshots.sort((a, b) => a.point.epoch - b.point.epoch);
	}

	async function getBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
		const timeoutController = new AbortController();
		const abortFromCaller = () => timeoutController.abort(signal?.reason);
		const timeout = window.setTimeout(
			() => timeoutController.abort(new DOMException('请求超时', 'TimeoutError')),
			10_000
		);
		signal?.addEventListener('abort', abortFromCaller, { once: true });

		try {
			const response = await fetch(url, { signal: timeoutController.signal });
			if (!response.ok) throw new Error(`请求失败 (${response.status})`);
			return response.arrayBuffer();
		} catch (error) {
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				throw new Error('接口响应超时');
			}
			throw error;
		} finally {
			window.clearTimeout(timeout);
			signal?.removeEventListener('abort', abortFromCaller);
		}
	}

	async function loadSupporterPopularity() {
		popularityController?.abort();
		popularityController = new AbortController();
		try {
			const payload = await getBinary(popularityUrl, popularityController.signal);
			const decoded = await decodeScoreData(payload, supporters.length);
			if (!decoded.times.length) throw new Error('接口未返回人气数据');
			let latestIndex = 0;
			for (let index = 1; index < decoded.times.length; index += 1) {
				if (decoded.times[index] > decoded.times[latestIndex]) latestIndex = index;
			}
			const ranked = supporters
				.map((supporter, index) => ({
					id: supporter.id,
					score: decoded.scores[latestIndex * decoded.characterCount + index] ?? 0
				}))
				.sort((a, b) => b.score - a.score || a.id - b.id);
			supporterPopularity = new Map(
				ranked.map((entry, index) => [entry.id, { score: entry.score, rank: index + 1 }])
			);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
		}
	}

	async function loadTimeline() {
		const isRefresh = snapshots.length > 0 && ranks.length > 0;
		let refreshBaseline: RankEntry[] = [];

		if (isRefresh) {
			const previousLatestIndex = snapshots.length - 1;
			refreshBaseline = normalizeRanks(snapshots[previousLatestIndex].entries, []).map((entry) => ({
				...entry,
				previousRank: undefined
			}));
			selectedIndex = previousLatestIndex;
			displayedIndex = previousLatestIndex;
			ranks = refreshBaseline;
			dragging = false;
			dragBaseline = undefined;
			queuedDragIndex = undefined;
		}

		timelineLoading = !timeline.length;
		rankLoading = !ranks.length;
		rankRefreshing = isRefresh;
		timelineError = '';
		rankError = '';
		rankController?.abort();
		rankController = new AbortController();
		try {
			const payload = await getBinary(`https://gf2-api.hamelon.cfd/${worldboss}/gun_rank/${rankId}`, rankController.signal);
			const nextSnapshots = await decodeGunRanks(payload);
			if (!nextSnapshots.length) throw new Error('接口未返回有效排行快照');
			snapshots = nextSnapshots;
			timeline = nextSnapshots.map((snapshot) => snapshot.point);
			chartScores = Object.fromEntries(
				nextSnapshots.map((snapshot, index) => [index, scoresFromRanks(snapshot.entries)])
			);
			selectedIndex = timeline.length - 1;
			displayedIndex = selectedIndex;
			ranks = normalizeRanks(
				nextSnapshots[selectedIndex].entries,
				isRefresh ? refreshBaseline : []
			);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			const message = error instanceof Error ? error.message : '榜单加载失败';
			if (!timeline.length) timelineError = message;
			rankError = message;
		} finally {
			timelineLoading = false;
			rankLoading = false;
			rankRefreshing = false;
		}
	}

	async function loadRanks(
		index = selectedIndex,
		_force = false,
		comparisonRanks: RankEntry[] = ranks,
		_dragRequest = false
	) {
		const snapshot = snapshots[index];
		if (!snapshot) return;
		ranks = normalizeRanks(snapshot.entries, comparisonRanks);
		displayedIndex = index;
	}

	function selectTime(event: Event) {
		const nextIndex = Number((event.currentTarget as HTMLInputElement).value);
		if (nextIndex === selectedIndex) return;
		if (!dragging) beginDrag();
		selectedIndex = nextIndex;
		queuedDragIndex = nextIndex;
		void processDragQueue();
	}

	function beginDrag() {
		if (dragging) return;
		dragging = true;
		dragBaseline = ranks.map((entry) => ({ ...entry }));
		queuedDragIndex = undefined;
	}

	async function processDragQueue() {
		if (dragRequestRunning) return;
		dragRequestRunning = true;

		try {
			while (queuedDragIndex !== undefined) {
				const waitTime = DRAG_UPDATE_INTERVAL - (Date.now() - lastDragRequestAt);
				if (waitTime > 0) {
					await new Promise((resolve) => window.setTimeout(resolve, waitTime));
				}
				const nextIndex = queuedDragIndex;
				queuedDragIndex = undefined;
				lastDragRequestAt = Date.now();
				await loadRanks(nextIndex, false, dragBaseline ?? ranks, true);
			}
		} finally {
			dragRequestRunning = false;
			if (!dragging) dragBaseline = undefined;
		}
	}

	function endDrag() {
		if (!dragging) return;
		dragging = false;
		if (displayedIndex !== selectedIndex) {
			queuedDragIndex = selectedIndex;
			void processDragQueue();
		} else if (!dragRequestRunning) {
			dragBaseline = undefined;
		}
	}

	function selectChartTime(index: number) {
		if (index === selectedIndex) return;
		const ownsGesture = !dragging;
		if (ownsGesture) beginDrag();
		selectedIndex = index;
		queuedDragIndex = index;
		void processDragQueue();
		if (ownsGesture) endDrag();
	}

	function handleChartRangeChange() {}

	async function initialize() {
		await Promise.all([loadTimeline(), loadSupporterPopularity()]);
	}

	onMount(() => {
		void initialize();
		return () => {
			rankController?.abort();
			popularityController?.abort();
		};
	});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<svelte:head>
	<title>{selectedSupporterName()} · {worldbossMeta.fullName} · GF2</title>
	<meta
		name="description"
		content="少女前线2：追放闪耀星愿排行榜。"
	/>
</svelte:head>

<main class="page-shell">
	<div class="page-boss-health"><BossHealth {worldboss} selectedEpoch={timeline[displayedIndex]?.epoch} /></div>
	<!-- 宽屏右侧悬浮频道入口暂时停用。 -->

	{#if supporterPanelOpen}
		<button
			class="supporter-backdrop"
			onclick={() => (supporterPanelOpen = false)}
			aria-label="关闭应援人形侧栏"
		></button>
		<aside class="supporter-panel" aria-label="应援人形" aria-modal="true" role="dialog">
			<div class="supporter-panel-header">
				<div>
					<strong>选择应援人形</strong>
				</div>
				<div class="supporter-panel-actions">
					<!-- 角色选择侧栏频道入口暂时停用。 -->
					<button onclick={() => (supporterPanelOpen = false)} aria-label="关闭侧栏" title="关闭">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
					</button>
				</div>
			</div>
			<div class="supporter-filters" aria-label="角色分类">
				<button class="active" aria-label="全部角色" title="全部角色"><i>◆</i></button>
				<button aria-label="防御" title="防御"><i>⬡</i></button>
				<button aria-label="火力" title="火力"><i>●</i></button>
				<button aria-label="突击" title="突击"><i>ϟ</i></button>
				<button aria-label="支援" title="支援"><i>✦</i></button>
				<button aria-label="其他" title="其他"><i>•••</i></button>
			</div>
			<div class="supporter-grid">
				{#each sortedSupporters() as supporter (supporter.id)}
					{@const popularity = supporterPopularity.get(supporter.id)}
					<button
						class="supporter-card"
						class:active={supporter.id === rankId}
						onclick={() => selectSupporter(supporter.id)}
						aria-label={`选择${supporter.name}`}
					>
						<div class="supporter-portrait">
							<span>{supporter.name.slice(0, 1)}</span>
							<img
								src={avatarUrl(supporter.id)}
								alt=""
								onload={(event) => ((event.currentTarget as HTMLImageElement).hidden = false)}
								onerror={(event) => ((event.currentTarget as HTMLImageElement).hidden = true)}
							/>
							<small>{supporter.name}</small>
						</div>
						<div class="supporter-card-score">
							<i>●</i>
							<strong>{popularity?.score ?? '--'}</strong>
						</div>
					</button>
				{/each}
			</div>
			<div class="supporter-sortbar" onfocusout={handleSortFocusOut}>
				<div class="supporter-sort-select">
					<button
						class="sort-trigger"
						onclick={() => (supporterSortMenuOpen = !supporterSortMenuOpen)}
						aria-haspopup="menu"
						aria-expanded={supporterSortMenuOpen}
					>
						<strong>{supporterSortMode === 'popularity' ? '人气排名' : '默认排序'}</strong>
					</button>
					{#if supporterSortMenuOpen}
						<div class="supporter-sort-menu" role="menu">
							<button class:selected={supporterSortMode === 'default'} onclick={() => selectSupporterSortMode('default')} role="menuitem">默认排序</button>
							<button class:selected={supporterSortMode === 'popularity'} onclick={() => selectSupporterSortMode('popularity')} role="menuitem">人气排名</button>
						</div>
					{/if}
				</div>
				<button class="sort-direction" onclick={() => (supporterSortDescending = !supporterSortDescending)} aria-label="切换排序方向" title="切换排序方向">{supporterSortDescending ? '↓' : '↑'}</button>
			</div>
		</aside>
	{/if}

	<section class="rank-section" aria-label="排行榜">
		<div class="section-heading">
			<div class="supporter-lockup">
				<a class="rank-back" href={`/${worldboss}`} aria-label="返回人形排行" title="返回人形排行">
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7M8 12h10" /></svg>
				</a>
				<button
					class="supporter-avatar"
					onclick={() => (supporterPanelOpen = true)}
					aria-label="打开应援人形侧栏"
					title="应援人形"
				>
					{#key rankId}
						<img
							src={avatarUrl(rankId)}
							alt=""
							hidden
							onload={(event) => ((event.currentTarget as HTMLImageElement).hidden = false)}
							onerror={(event) => ((event.currentTarget as HTMLImageElement).hidden = true)}
						/>
					{/key}
					<i aria-hidden="true"><b></b><b></b></i>
				</button>
				<div class="supporter-copy">
					<span>当前应援人形：</span>
					<strong>{selectedSupporterName()}</strong>
				</div>
			</div>
			<div class="record-lockup">
				<div class="record-copy">
					<span>记录时间</span>
					<strong>{formatTime(timeline[displayedIndex])}</strong>
				</div>
				<button class="refresh-button" onclick={initialize} aria-label="刷新排行榜" title="刷新排行榜">
					<svg class:spinning={rankRefreshing} viewBox="0 0 24 24" aria-hidden="true">
						<path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 9m0-4v4h4M4 13a8.1 8.1 0 0 0 14.9 4L21 15m0 4v-4h-4" />
					</svg>
				</button>
			</div>
		</div>

		<div class="column-labels" aria-hidden="true">
			<span>排名</span><span>玩家信息</span><span>累计助力值</span>
		</div>

		{#if rankLoading}
			<div class="rank-list skeleton-list" aria-label="正在载入排行榜">
				{#each Array(12) as _, index}
					<div class="rank-row skeleton-row" style={`--delay:${index * 55}ms`}>
						<div class="skeleton rank-placeholder"></div>
						<div class="skeleton name-placeholder"></div>
						<div class="skeleton score-placeholder"></div>
					</div>
				{/each}
			</div>
		{:else if rankError && !ranks.length}
			<div class="state-panel">
				<div class="state-code">OFFLINE</div>
				<h3>无法读取排行榜</h3>
				<p>{rankError}</p>
				<button onclick={() => loadRanks(selectedIndex, true)}>重新连接</button>
			</div>
		{:else if !ranks.length}
			<div class="state-panel">
				<div class="state-code">NO DATA</div>
				<h3>该时间点暂无记录</h3>
				<p>沿时间轴切换到其他有效记录点。</p>
			</div>
		{:else}
			<div
				class="rank-list motion-list"
				class:refreshing={rankRefreshing}
				style={`--row-count:${ranks.length}`}
			>
				{#each ranks as entry, index (entry.id)}
					<article
						class:podium={entry.rank <= 3}
						class={`rank-row rank-${Math.min(entry.rank, 4)}`}
						style={`--row-index:${index}`}
						in:fade={{ duration: 160 }}
						out:fade={{ duration: 180 }}
					>
						<div class="score-fill" style={`width:${scoreWidth(entry.score)}%`}></div>
						<div class="rank-number">
							<strong>{String(entry.rank).padStart(2, '0')}</strong>
							<span>BEST OF TOP</span>
						</div>
						<div class="operator">
							<div class="operator-name">
								<strong>{entry.name}</strong>
								{#if rankMovement(entry) === 'up'}
									<span class="movement up" title="名次上升">▲ {movementAmount(entry)}</span>
								{:else if rankMovement(entry) === 'down'}
									<span class="movement down" title="名次下降">▼ {movementAmount(entry)}</span>
								{/if}
							</div>
							<span class="level">Lv.{entry.level}</span>
						</div>
						<div class="score">
							<span>累计助力</span>
							<strong>{entry.score}</strong>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<section class="timeline-panel" aria-label="历史时间轴">
		{#if timelineLoading}
			<div class="timeline-loading"><span></span>正在读取有效时间点</div>
		{:else if timelineError}
			<div class="timeline-error">
				<span>{timelineError}</span>
				<button onclick={initialize}>重试</button>
			</div>
		{:else}
			<RankTimelineChart
				{timeline}
				scores={chartScores}
				{selectedIndex}
				loadingCount={0}
				onSelect={selectChartTime}
				onRangeChange={handleChartRangeChange}
				onScrubStart={beginDrag}
				onScrubEnd={endDrag}
			/>
		{/if}
	</section>
</main>
