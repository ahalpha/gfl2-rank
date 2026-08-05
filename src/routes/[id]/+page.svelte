<script lang="ts">
	import { page } from '$app/state';
	import CharacterRankPage from '$lib/CharacterRankPage.svelte';

	const initialRankId = Number(page.params.id);
</script>

<CharacterRankPage initialRankId={Number.isInteger(initialRankId) ? initialRankId : 1078} />
