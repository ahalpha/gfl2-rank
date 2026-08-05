<script lang="ts">
	import OverallRankPage from '../+page.svelte';
	import chars from '$lib/data/worldboss_3_chars.json';
</script>

<OverallRankPage worldboss="worldboss_3" {chars} />
