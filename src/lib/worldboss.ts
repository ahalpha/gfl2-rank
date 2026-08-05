const WORLDBOSS_META = {
	worldboss_2: {
		shortName: '夺星季',
		fullName: '闪耀星愿·夺星季'
	},
	worldboss_3: {
		shortName: '观星巡礼',
		fullName: '闪耀星愿·观星巡礼'
	}
} as const;

export function getWorldbossMeta(worldboss: string) {
	return WORLDBOSS_META[worldboss as keyof typeof WORLDBOSS_META] ?? WORLDBOSS_META.worldboss_3;
}
