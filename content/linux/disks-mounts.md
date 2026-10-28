## story | Plenty of space, no space left

Lumen's thumbnail service started failing with `No space left on device`. The on-call engineer ran `df -h`: 3% used. They restarted the service, cleared `/tmp`, and lost an hour. The filesystem had run out of **inodes**, not bytes: a million tiny thumbnail files had used every file slot it had.

The same week, uploads filled the root disk, and someone attached a new 50 GB cloud volume. It sat unused for days because nobody knew how to put a filesystem on it and mount it permanently. When they finally did, a typo in `/etc/fstab` stopped the server from booting.

## model | Devices, filesystems and the mount tree

- A **block device** is a disk (`/dev/xvda`, `/dev/nvme1n1`, `/dev/sdb`) or a **partition** of one (`/dev/xvda1`). `lsblk` shows them as a tree.
- A **filesystem** (ext4, xfs) organises a device into files. `mkfs.ext4 /dev/xvdf` creates one, **erasing what was there**. `blkid` prints each filesystem's **UUID**.
- Linux has **one directory tree**. **Mounting** attaches a filesystem at a directory (the **mount point**): `mount /dev/xvdf /srv/uploads`. Files you write there land on that device. Unmount it, and the directory shows what was underneath again.
- A filesystem has two limits: **bytes** (`df -h`) and **inodes** (`df -i`), one per file or directory. Millions of tiny files can exhaust inodes with the disk nearly empty.
- **`/etc/fstab`** lists what to mount at boot: `UUID=… /srv/uploads ext4 defaults,nofail 0 2`. Use the **UUID**, because device names like `/dev/xvdf` can change between boots. **`nofail`** lets the server boot even if the volume is missing.
- `mount -a` mounts everything in fstab that is not mounted yet: **test every fstab change with it before you reboot.** A broken entry without `nofail` drops the machine into **emergency mode** at the next boot, where only a console can reach it.

## commands | Find, format, mount, persist

```term
$ df -h                                  # bytes per filesystem
$ df -i                                  # inodes per filesystem
$ sudo find /var/cache/thumbs -xdev -type f -mtime +7 -delete
$ lsblk                                  # disks, partitions, mount points
$ lsblk -f                               # plus filesystem type and UUID
$ sudo mkfs.ext4 /dev/xvdf               # new filesystem (destroys data!)
$ sudo blkid /dev/xvdf
$ sudo mkdir -p /srv/uploads && sudo mount /dev/xvdf /srv/uploads
$ sudo cp -a /var/www/uploads/. /srv/uploads/      # -a keeps owners, modes, times
$ echo "UUID=$(sudo blkid -s UUID -o value /dev/xvdf) /srv/uploads ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
$ sudo umount /srv/uploads && sudo mount -a && findmnt /srv/uploads   # test it
```

## analogy | Shelves and index cards

A disk is a warehouse. Bytes are shelf space; inodes are index cards in the catalogue, one per item. Run out of cards and you cannot store a single new item, however empty the shelves. Mounting is opening a door from your shop floor into another warehouse: the corridor looks like part of the same building.

## team | Storage in a team

- **Alert on inodes as well as bytes** (node_exporter has both), at 80%, not 100%.
- **Separate volumes for data that grows**: uploads, databases and logs on their own filesystems, so a full one cannot stop the system.
- **Everything about a volume in code**: create and attach it with Terraform, format and mount it with cloud-init or Ansible. A volume mounted by hand on one server is forgotten on the next.
- **Test fstab changes immediately** (`mount -a`, `findmnt --verify`) and keep a console path to every server.

## traps | Storage traps

**`df -h` looks fine** but writes fail: check `df -i`.

**mkfs on the wrong device.** Read `lsblk` twice; mkfs does not ask twice.

**Writing into a mount point before mounting**: those files are hidden under the mount, still using space on the root disk.

**`/dev/xvdf` in fstab.** Device names can change after a reboot or a new attachment; use `UUID=`.

**No `nofail` on a data volume**: if the volume is detached, the server does not boot.

**`rm -rf dir/*` on a million files**: `Argument list too long`. `find … -delete` works through any number.

## lab | The thumbnails and the new volume

`web1` serves Lumen's uploads and thumbnails. Thumbnails stopped working, and a new 50 GB volume is waiting to take the uploads off the root disk. Fix the first, and put the second into service in a way that survives a reboot.
