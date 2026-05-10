import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user submits. The host opens a terminal tab, queues the
   *  password for one-shot use, and kicks off the parallel SFTP connection
   *  using the same credentials. */
  onConnect: (target: string, password: string | null) => void;
};

export function SshConnectDialog({ open, onOpenChange, onConnect }: Props) {
  const [target, setTarget] = useState("");
  const [password, setPassword] = useState("");
  const targetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTarget("");
    setPassword("");
    setTimeout(() => targetRef.current?.focus(), 0);
  }, [open]);

  const submit = () => {
    const t = target.trim();
    if (!t) return;
    onConnect(t, password ? password : null);
    // Wipe the local copy of the password as soon as we hand it off — the
    // terminal pane and the SFTP bridge each consume it once.
    setPassword("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={Globe02Icon} size={16} strokeWidth={1.75} />
            New SSH session
          </DialogTitle>
          <DialogDescription>
            Opens a terminal tab and a parallel SFTP connection so the file
            explorer follows the remote machine.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Host
            </label>
            <Input
              ref={targetRef}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="user@host or user@host:port"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Password{" "}
              <span className="text-muted-foreground/70">
                (leave blank to use ssh-agent or a key)
              </span>
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="optional"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <DialogFooter className="mt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!target.trim()}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
