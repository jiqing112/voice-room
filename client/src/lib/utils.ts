import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui 标配的类名合并工具：clsx 负责拼接，tailwind-merge 去掉冲突类
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
