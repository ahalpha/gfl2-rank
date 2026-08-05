<script lang="ts">
	import { page } from '$app/state';
	import CharacterRankPage from '$lib/CharacterRankPage.svelte';
	import chars from '$lib/data/worldboss_2_chars.json';

	const initialRankId = Number(page.params.id);
</script>

<CharacterRankPage worldboss="worldboss_2" {chars} initialRankId={Number.isInteger(initialRankId) ? initialRankId : 1070} />
