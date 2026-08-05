<script lang="ts">
	import { onMount } from 'svelte';
	import { decodeBossInfo } from '$lib/rank-decoder';

	const MAX_HEALTH = 10_000_000_000n;
	type BossPoint = { epoch: number; health: bigint };

	let { selectedEpoch, worldboss = 'worldboss_3' }: { selectedEpoch?: number; worldboss?: string } = $props();
	const infoUrl = `https://gf2-api.hamelon.cfd/${worldboss}/info`;
	let points = $state<BossPoint[]>([]);
	let failed = $state(false);

	let selectedHealth = $derived.by(() => {
		if (!points.length || selectedEpoch === undefined) return undefined;
		let low = 0;
		let high = points.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (points[middle].epoch < selectedEpoch) low = middle + 1;
			else high = middle;
		}
		const next = points[low];
		const previous = points[low - 1];
		if (!previous) return next?.health;
		if (!next) return previous.health;
		return next.epoch - selectedEpoch < selectedEpoch - previous.epoch ? next.health : previous.health;
	});

	let fillPercent = $derived.by(() => {
		if (selectedHealth === undefined || selectedHealth <= 0n) return 0;
		const bounded = selectedHealth > MAX_HEALTH ? MAX_HEALTH : selectedHealth;
		return Number((bounded * 10_000n) / MAX_HEALTH) / 100;
	});
	let displayedHealth = $derived(selectedHealth === undefined ? '--' : `${selectedHealth / 10_000n}w`);

	onMount(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await fetch(infoUrl, { signal: controller.signal });
				if (!response.ok) throw new Error(`Boss info request failed (${response.status})`);
				const decoded = await decodeBossInfo(await response.arrayBuffer());
				points = Array.from(decoded.times, (epoch, index) => ({ epoch, health: decoded.health[index] }))
					.sort((a, b) => a.epoch - b.epoch);
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'AbortError')) failed = true;
			}
		})();
		return () => controller.abort();
	});
</script>

<div class="boss-health" class:failed aria-label="Boss 当前血量">
	<div class="boss-health-fill" style:width={`${fillPercent}%`}></div>
	<div class="boss-health-value">
		<strong>{displayedHealth}</strong><span>/1000000w</span>
	</div>
</div>

<style>
	.boss-health {
		position: relative;
		width: 100%;
		height: 24px;
		overflow: hidden;
		color: #fff;
		background: #313131;
		box-shadow: inset 0 1px rgba(255,255,255,.08);
	}
	.boss-health-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: #3d66dd;
		transition: width 180ms ease-out;
	}
	.boss-health-value {
		position: relative;
		z-index: 1;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font: 800 13px Consolas,monospace;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 1px 2px rgba(0,0,0,.7);
	}
	.boss-health-value span { color: #d7d9da; }
	.boss-health.failed .boss-health-value { opacity: .55; }
	@media(max-width:760px) {
		.boss-health { height: 21px; }
		.boss-health-value { font-size: 11px; }
	}
</style>
