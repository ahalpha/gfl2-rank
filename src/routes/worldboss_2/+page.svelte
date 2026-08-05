<script lang="ts">
	import OverallRankPage from '../+page.svelte';
	import chars from '$lib/data/worldboss_2_chars.json';
</script>

<OverallRankPage worldboss="worldboss_2" {chars} />
