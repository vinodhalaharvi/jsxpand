import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InviteDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Invite</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>They will get an email.</DialogDescription>
        </DialogHeader>
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" type="email" placeholder="you@example.com" />
        <DialogFooter>
          <Button type="submit">Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
