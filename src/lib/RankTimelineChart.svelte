<script lang="ts">
	import { onMount } from 'svelte';
	import * as echarts from 'echarts/core';
	import { LineChart } from 'echarts/charts';
	import {
		AxisPointerComponent,
		DataZoomComponent,
		GridComponent,
		MarkLineComponent,
		TooltipComponent
	} from 'echarts/components';
	import { CanvasRenderer } from 'echarts/renderers';
	import type { EChartsCoreOption } from 'echarts/core';

	echarts.use([
		LineChart,
		AxisPointerComponent,
		DataZoomComponent,
		GridComponent,
		MarkLineComponent,
		TooltipComponent,
		CanvasRenderer
	]);

	type TimelinePoint = { raw: string | number; epoch: number };
	type ScorePoint = { rank1: number; rank2: number; rank3: number; rank100: number };
	type SeriesKey = keyof ScorePoint;

	let {
		timeline,
		scores,
		selectedIndex,
		loadingCount = 0,
		onSelect,
		onRangeChange,
		onScrubStart,
		onScrubEnd
	}: {
		timeline: TimelinePoint[];
		scores: Record<number, ScorePoint>;
		selectedIndex: number;
		loadingCount?: number;
		onSelect: (index: number) => void;
		onRangeChange: (start: number, end: number) => void;
		onScrubStart?: () => void;
		onScrubEnd?: () => void;
	} = $props();

	let container = $state<HTMLDivElement>();
	let chart = $state.raw<ReturnType<typeof echarts.init>>();
	let initializedTimelineLength = 0;
	let pointerDownX = 0;
	let pointerDownY = 0;
	let pointerMoved = false;
	let selectionDragging = false;
	let compactViewport = $state(false);
	const touchPointers = new Set<number>();
	let touchGestureUsedMultiplePointers = false;

	const seriesDefinitions: Array<{ key: SeriesKey; name: string; color: string }> = [
		{ key: 'rank100', name: '第 100 名', color: '#c5c4c5' },
		{ key: 'rank3', name: '第 3 名', color: '#4d7cff' },
		{ key: 'rank2', name: '第 2 名', color: '#ffb356' },
		{ key: 'rank1', name: '第 1 名', color: '#e93b60' }
	];

	$effect(() => {
		if (!chart || !timeline.length) return;
		const isNewTimeline = initializedTimelineLength !== timeline.length;
		const option = buildOption(isNewTimeline);
		chart.setOption(option, { notMerge: false, lazyUpdate: true });
		if (isNewTimeline) {
			initializedTimelineLength = timeline.length;
			const end = timeline.at(-1)!.epoch;
			const start = Math.max(timeline[0].epoch, end - 24 * 60 * 60 * 1000);
			onRangeChange(start, end);
		}
	});

	onMount(() => {
		if (!container) return;
		chart = echarts.init(container, undefined, { renderer: 'canvas' });

		const resizeObserver = new ResizeObserver(([entry]) => {
			compactViewport = entry.contentRect.width <= 760;
			chart?.resize();
		});
		resizeObserver.observe(container);

		chart.on('datazoom', handleDataZoom);
		container.addEventListener('pointerdown', handlePointerDown, true);
		container.addEventListener('pointermove', handlePointerMove, true);
		container.addEventListener('pointerup', handlePointerUp, true);
		container.addEventListener('pointercancel', handlePointerUp, true);

		return () => {
			resizeObserver.disconnect();
			container?.removeEventListener('pointerdown', handlePointerDown, true);
			container?.removeEventListener('pointermove', handlePointerMove, true);
			container?.removeEventListener('pointerup', handlePointerUp, true);
			container?.removeEventListener('pointercancel', handlePointerUp, true);
			chart?.dispose();
			chart = undefined;
		};
	});

	function buildOption(includeInitialRange: boolean): EChartsCoreOption {
		const fullStart = timeline[0].epoch;
		const fullEnd = timeline.at(-1)!.epoch;
		const selectedEpoch = timeline[selectedIndex]?.epoch;
		const horizontalInset = compactViewport ? 20 : 38;
		const dataZoom: Record<string, unknown> = {
			id: 'timeline-inside',
			type: 'inside',
			xAxisIndex: 0,
			filterMode: 'none',
			zoomOnMouseWheel: true,
			moveOnMouseWheel: false,
			moveOnMouseMove: true,
			preventDefaultMouseMove: true,
			// Reduce the amount of range change produced by each touch pinch.
			zoomSensitivity: compactViewport ? 0.35 : 1,
			throttle: compactViewport ? 100 : 40,
			minValueSpan: 60_000
		};
		if (includeInitialRange) {
			dataZoom.startValue = Math.max(fullStart, fullEnd - 24 * 60 * 60 * 1000);
			dataZoom.endValue = fullEnd;
		}

		return {
			animation: true,
			animationDuration: 420,
			animationDurationUpdate: 280,
			animationEasing: 'cubicOut',
			animationEasingUpdate: 'cubicOut',
			color: seriesDefinitions.map((item) => item.color),
			grid: { left: horizontalInset, right: horizontalInset, top: 28, bottom: 28, containLabel: false },
			tooltip: {
				trigger: 'axis',
				confine: true,
				backgroundColor: '#eceeed',
				borderWidth: 0,
				padding: [7, 10],
				textStyle: { color: '#24282b', fontSize: 11 },
				axisPointer: { type: 'line', lineStyle: { color: '#d7dadd', type: 'dashed' } },
				valueFormatter: (value: unknown) => Number(value ?? 0).toLocaleString('zh-CN')
			},
			xAxis: {
				type: 'time',
				min: fullStart,
				max: fullEnd,
				boundaryGap: false,
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: '#8d9397', fontSize: 9, hideOverlap: true },
				splitLine: { show: false }
			},
			yAxis: {
				type: 'value',
				min: 0,
				scale: true,
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { show: false },
				splitLine: { show: false }
			},
			dataZoom: [dataZoom],
			series: seriesDefinitions.map(({ key, name, color }, seriesIndex) => ({
				id: key,
				name,
				type: 'line',
				stack: 'Total',
				data: timeline.map((point, index) => [point.epoch, scores[index]?.[key] ?? null]),
				showSymbol: false,
				symbol: 'circle',
				symbolSize: 7,
				connectNulls: true,
				smooth: true,
				sampling: 'lttb',
				lineStyle: { width: 0, color },
				itemStyle: { color, borderColor: color },
				areaStyle: { opacity: 0.8, color },
				emphasis: {
					focus: 'series',
					itemStyle: { color, borderColor: '#ffffff', borderWidth: 2 }
				},
				label: seriesIndex === seriesDefinitions.length - 1
					? { show: true, position: 'top', color: '#e93b60' }
					: undefined,
				z: seriesIndex + 1,
				markLine: seriesIndex === seriesDefinitions.length - 1 && selectedEpoch !== undefined
					? {
						silent: true,
						symbol: ['none', 'circle'],
						symbolSize: [0, 10],
						label: { show: false },
						lineStyle: { color: '#f4f5f3', width: 1, type: 'dashed', opacity: .9 },
						data: [{ xAxis: selectedEpoch }]
					}
					: undefined
			}))
		};
	}

	function handleDataZoom(event: unknown) {
		if (!timeline.length) return;
		const payload = event as { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> };
		const zoom = payload.batch?.[0] ?? payload;
		if (zoom.start === undefined || zoom.end === undefined) return;
		const fullStart = timeline[0].epoch;
		const span = timeline.at(-1)!.epoch - fullStart;
		onRangeChange(fullStart + span * (zoom.start / 100), fullStart + span * (zoom.end / 100));
	}

	function handlePointerDown(event: PointerEvent) {
		pointerDownX = event.clientX;
		pointerDownY = event.clientY;
		pointerMoved = false;
		if (event.pointerType === 'mouse') {
			chart?.setOption({ dataZoom: [{ id: 'timeline-inside', disabled: !event.ctrlKey }] });
			if (!event.ctrlKey && isInsideGrid(event)) {
				selectionDragging = true;
				container?.setPointerCapture(event.pointerId);
				onScrubStart?.();
				selectFromPointer(event);
			}
		} else {
			touchPointers.add(event.pointerId);
			if (touchPointers.size > 1) touchGestureUsedMultiplePointers = true;
			chart?.setOption({ dataZoom: [{ id: 'timeline-inside', disabled: false }] });
		}
	}

	function handlePointerMove(event: PointerEvent) {
		if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 6) pointerMoved = true;
		if (selectionDragging && event.pointerType === 'mouse') {
			event.preventDefault();
			selectFromPointer(event);
		}
	}

	function handlePointerUp(event: PointerEvent) {
		const touchTap = event.type === 'pointerup' && event.pointerType === 'touch' && touchPointers.size === 1 &&
			!pointerMoved && !touchGestureUsedMultiplePointers && isInsideGrid(event);
		if (selectionDragging) {
			selectFromPointer(event);
			selectionDragging = false;
			onScrubEnd?.();
		}
		if (event.pointerType === 'touch') {
			touchPointers.delete(event.pointerId);
			if (touchTap) selectFromPointer(event);
			if (!touchPointers.size) touchGestureUsedMultiplePointers = false;
		}
		if (container?.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
		queueMicrotask(() => chart?.setOption({ dataZoom: [{ id: 'timeline-inside', disabled: false }] }));
	}

	function pointerPixel(event: PointerEvent): [number, number] {
		const rect = container!.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	}

	function isInsideGrid(event: PointerEvent): boolean {
		return Boolean(chart?.containPixel({ gridIndex: 0 }, pointerPixel(event)));
	}

	function selectFromPointer(event: PointerEvent) {
		if (!chart || !timeline.length) return;
		const pixel = pointerPixel(event);
		const horizontalInset = compactViewport ? 20 : 38;
		const clampedX = Math.max(horizontalInset, Math.min(container!.clientWidth - horizontalInset, pixel[0]));
		const converted = chart.convertFromPixel({ gridIndex: 0 }, [clampedX, pixel[1]]) as [number, number];
		selectClosestTime(Number(converted[0]));
	}

	function selectClosestTime(epoch: number) {
		if (!timeline.length) return;
		let low = 0;
		let high = timeline.length - 1;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (timeline[middle].epoch < epoch) low = middle + 1;
			else high = middle;
		}
		const before = Math.max(0, low - 1);
		const index = Math.abs(timeline[low].epoch - epoch) < Math.abs(timeline[before].epoch - epoch) ? low : before;
		onSelect(index);
	}

</script>

<div class="chart-shell">
	<div class="plot-background" aria-hidden="true"></div>
	<div class="echarts-host" bind:this={container} aria-label="第 1、2、3、100 名分数时间轴"></div>
	{#if loadingCount}<div class="loading-badge"><i></i>{loadingCount} 个时间点载入中</div>{/if}
</div>

<style>
	.chart-shell { position: relative; width: 100%; min-width: 0; height: 120px; background: transparent; }
	.echarts-host { position: relative; z-index: 1; width: 100%; height: 100%; touch-action: none; }
	.plot-background { position: absolute; z-index: 0; left: 38px; right: 38px; top: 28px; bottom: 28px; outline: 3px solid #83c3ff80; background: #d6d6d6; }
	.loading-badge { position: absolute; right: 20px; top: 8px; display: flex; align-items: center; gap: 7px; color: #8f9599; font-size: 10px; pointer-events: none; }
	.loading-badge i { width: 10px; height: 10px; border: 2px solid #555b5f; border-top-color: #e93b60; border-radius: 50%; animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (max-width: 760px) {
		.chart-shell { height: 120px; }
		.plot-background { left: 20px; right: 20px; }
		.loading-badge { display: none; }
	}
</style>
