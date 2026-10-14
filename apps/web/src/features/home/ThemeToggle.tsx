import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ComponentType } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useSidebarMenu } from "./sidebar-menu";

type Option = {
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
};

// One label and icon per preference. "system" follows the OS live, which a
// two-state toggle would lose.
const OPTIONS: Record<ThemePreference, Option> = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  system: { label: "System", Icon: Monitor },
};

const ORDER: readonly ThemePreference[] = ["light", "dark", "system"];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const current = OPTIONS[preference];
  const menu = useSidebarMenu();

  return (
    <DropdownMenu {...menu.rootProps}>
      <DropdownMenuTrigger
        {...menu.triggerProps}
        data-testid="theme-toggle"
        aria-label={`Theme: ${current.label}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-text focus-visible:text-text"
      >
        <current.Icon className="size-[15px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent {...menu.contentProps} align="end" className="min-w-[9rem]">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(next) => setPreference(next as ThemePreference)}
        >
          {ORDER.map((value) => {
            const { label, Icon } = OPTIONS[value];
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon className="size-[15px] text-muted-foreground" />
                {label}
                <DropdownMenuRadioItemIndicator className="ml-auto flex">
                  <Check className="size-[14px]" />
                </DropdownMenuRadioItemIndicator>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
